import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JobStatus } from "@prisma/client";
import { DynamoService } from "../../src/infrastructure/dynamo/dynamo.service";
import { PrismaService } from "../../src/infrastructure/prisma/prisma.service";
import { S3Service } from "../../src/infrastructure/storage/s3.service";
import { JobsService } from "../../src/jobs/jobs.service";
import { ListJobsQueryDto } from "../../src/jobs/dto/list-jobs-query.dto";

describe("JobsService edge cases", () => {
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
    createSignedDownloadUrl: jest.fn(),
  };

  const dynamoServiceMock = {
    createJobSession: jest.fn(),
    acquireUserSlot: jest.fn(),
    releaseUserSlot: jest.fn(),
  };

  const configServiceMock = {
    get: jest.fn(),
  };

  let service: JobsService;

  beforeEach(() => {
    jest.clearAllMocks();

    prismaServiceMock.job.create.mockResolvedValue({ id: "job-1" });
    prismaServiceMock.job.update.mockResolvedValue({});
    prismaServiceMock.job.count.mockResolvedValue(0);
    prismaServiceMock.job.findMany.mockResolvedValue([]);
    prismaServiceMock.job.findFirst.mockResolvedValue({
      id: "job-1",
      userId: "user-1",
      status: JobStatus.done,
      generatedObjectKey: "jobs/job-1/generated.pdf",
    });

    s3ServiceMock.uploadObject.mockResolvedValue({ bucket: "b", key: "k" });
    s3ServiceMock.createSignedDownloadUrl.mockResolvedValue("https://signed");
    dynamoServiceMock.createJobSession.mockResolvedValue(undefined);
    dynamoServiceMock.acquireUserSlot.mockResolvedValue({ acquired: true });
    dynamoServiceMock.releaseUserSlot.mockResolvedValue(undefined);

    service = new JobsService(
      prismaServiceMock as unknown as PrismaService,
      s3ServiceMock as unknown as S3Service,
      dynamoServiceMock as unknown as DynamoService,
      configServiceMock as unknown as ConfigService,
    );
  });

  it("defaults pagination when query is empty", async () => {
    const query = new ListJobsQueryDto();
    const result = await service.findJobsByUser("user-1", query);

    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
    expect(prismaServiceMock.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 10 }),
    );
  });

  it("uploads a paci file when paciJson is not provided", async () => {
    await expect(
      service.createUploadJob(
        "user-1",
        { prompt: "  hola  " },
        {
          paciFile: [
            {
              originalname: "paci.PDF",
              mimetype: "application/pdf",
              buffer: Buffer.from("paci"),
            },
          ],
          planningFile: [
            {
              originalname: "plan.DOCX",
              mimetype:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              buffer: Buffer.from("plan"),
            },
          ],
        },
      ),
    ).resolves.toEqual({ jobId: "job-1", status: JobStatus.pending });

    expect(dynamoServiceMock.createJobSession).toHaveBeenCalledWith(
      "job-1",
      "user-1",
      "jobs/job-1/paci.pdf",
      "jobs/job-1/material.docx",
      "hola",
    );
  });

  it("rejects planning files with unsupported mime type", async () => {
    await expect(
      service.createUploadJob(
        "user-1",
        { paciJson: "{}" },
        {
          planningFile: [
            {
              originalname: "plan.txt",
              mimetype: "text/plain",
              buffer: Buffer.from("plan"),
            },
          ],
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("uses default expiresIn when config is missing", async () => {
    configServiceMock.get.mockImplementation((key: string, defaultValue?: number) =>
      key === "PACI_DOCUMENTS_URL_EXPIRES_IN" ? defaultValue : undefined,
    );

    await expect(service.getDownloadUrl("user-1", "job-1")).resolves.toEqual({
      url: "https://signed",
      expiresInSeconds: 900,
    });
  });
});
