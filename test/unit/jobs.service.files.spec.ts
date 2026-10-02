import { ConfigService } from "@nestjs/config";
import { JobStatus } from "@prisma/client";
import { DynamoService } from "../../src/infrastructure/dynamo/dynamo.service";
import { PrismaService } from "../../src/infrastructure/prisma/prisma.service";
import { S3Service } from "../../src/infrastructure/storage/s3.service";
import { JobsService } from "../../src/jobs/jobs.service";

describe("JobsService file handling", () => {
  const prismaServiceMock = {
    job: {
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  const s3ServiceMock = {
    uploadObject: jest.fn(),
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
    s3ServiceMock.uploadObject.mockResolvedValue({ bucket: "b", key: "k" });
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

  it("defaults PACI extension to .pdf when missing", async () => {
    await expect(
      service.createUploadJob(
        "user-1",
        { prompt: "hola" },
        {
          paciFile: [
            {
              originalname: "paci",
              mimetype: "application/pdf",
              buffer: Buffer.from("paci"),
            },
          ],
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
    ).resolves.toEqual({ jobId: "job-1", status: JobStatus.pending });

    expect(dynamoServiceMock.createJobSession).toHaveBeenCalledWith(
      "job-1",
      "user-1",
      "jobs/job-1/paci.pdf",
      "jobs/job-1/material.docx",
      "hola",
    );
  });

  it("lowercases the content type before upload", async () => {
    await service.createUploadJob(
      "user-1",
      { prompt: "hola" },
      {
        paciFile: [
          {
            originalname: "paci.PDF",
            mimetype: "Application/PDF",
            buffer: Buffer.from("paci"),
          },
        ],
        planningFile: [
          {
            originalname: "plan.DOCX",
            mimetype:
              "Application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            buffer: Buffer.from("plan"),
          },
        ],
      },
    );

    const paciUpload = s3ServiceMock.uploadObject.mock.calls[0][0];
    const planningUpload = s3ServiceMock.uploadObject.mock.calls[1][0];

    expect(paciUpload.contentType).toBe("application/pdf");
    expect(planningUpload.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });
});
