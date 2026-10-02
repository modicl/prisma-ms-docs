import {
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JobStatus } from "@prisma/client";
import { DynamoService } from "../../src/infrastructure/dynamo/dynamo.service";
import { PrismaService } from "../../src/infrastructure/prisma/prisma.service";
import { S3Service } from "../../src/infrastructure/storage/s3.service";
import { JobsService } from "../../src/jobs/jobs.service";

describe("JobsService additional cases", () => {
  const prismaServiceMock = {
    job: {
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
  };

  const s3ServiceMock = {
    uploadObject: jest.fn(),
  };

  const dynamoServiceMock = {
    createJobSession: jest.fn(),
    acquireUserSlot: jest.fn(),
    releaseUserSlot: jest.fn(),
    listSessionsByUser: jest.fn(),
  };

  const configServiceMock = {
    get: jest.fn(),
  };

  let service: JobsService;

  beforeEach(() => {
    jest.clearAllMocks();

    prismaServiceMock.job.create.mockResolvedValue({ id: "job-1" });
    prismaServiceMock.job.update.mockResolvedValue({});
    prismaServiceMock.job.findFirst.mockResolvedValue(null);

    s3ServiceMock.uploadObject.mockResolvedValue({ bucket: "b", key: "k" });
    dynamoServiceMock.createJobSession.mockResolvedValue(undefined);
    dynamoServiceMock.acquireUserSlot.mockResolvedValue({ acquired: true });
    dynamoServiceMock.releaseUserSlot.mockResolvedValue(undefined);
    dynamoServiceMock.listSessionsByUser.mockResolvedValue([{ sessionId: "s1" }]);

    service = new JobsService(
      prismaServiceMock as unknown as PrismaService,
      s3ServiceMock as unknown as S3Service,
      dynamoServiceMock as unknown as DynamoService,
      configServiceMock as unknown as ConfigService,
    );
  });

  it("updates the job status when DynamoDB fails", async () => {
    dynamoServiceMock.createJobSession.mockRejectedValue(new Error("boom"));

    await expect(
      service.createUploadJob(
        "user-1",
        { paciJson: "{}" },
        {
          planningFile: [
            {
              originalname: "plan.docx",
              mimetype:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              buffer: Buffer.from("plan"),
            },
          ],
        },
      ),
    ).rejects.toThrow("boom");

    expect(prismaServiceMock.job.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: {
        status: JobStatus.error,
        errorMessage: "boom",
      },
    });
    expect(s3ServiceMock.uploadObject).not.toHaveBeenCalled();
  });

  it("returns history from DynamoDB", async () => {
    await expect(service.getHistoryByUser("user-1")).resolves.toEqual([
      { sessionId: "s1" },
    ]);

    expect(dynamoServiceMock.listSessionsByUser).toHaveBeenCalledWith("user-1");
  });

  it("rejects when the job does not belong to the user", async () => {
    await expect(service.findJobStatus("user-1", "job-404")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects invalid PACI file types", async () => {
    await expect(
      service.createUploadJob(
        "user-1",
        {},
        {
          paciFile: [
            {
              originalname: "paci.txt",
              mimetype: "text/plain",
              buffer: Buffer.from("paci"),
            },
          ],
          planningFile: [
            {
              originalname: "plan.pdf",
              mimetype: "application/pdf",
              buffer: Buffer.from("plan"),
            },
          ],
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
