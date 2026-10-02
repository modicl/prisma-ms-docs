import { ConfigService } from "@nestjs/config";
import { JobStatus } from "@prisma/client";
import { DynamoService } from "../../src/infrastructure/dynamo/dynamo.service";
import { PrismaService } from "../../src/infrastructure/prisma/prisma.service";
import { S3Service } from "../../src/infrastructure/storage/s3.service";
import { JobsService } from "../../src/jobs/jobs.service";

describe("JobsService error handling", () => {
  const prismaServiceMock = {
    job: {
      create: jest.fn(),
      update: jest.fn(),
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
  };

  const configServiceMock = {
    get: jest.fn(),
  };

  let service: JobsService;

  beforeEach(() => {
    jest.clearAllMocks();

    prismaServiceMock.job.create.mockResolvedValue({ id: "job-1" });
    prismaServiceMock.job.update.mockResolvedValue({});

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

  it("wraps non-error failures during upload", async () => {
    s3ServiceMock.uploadObject.mockRejectedValueOnce("boom");

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
    ).rejects.toThrow("Unexpected error creating job upload.");

    expect(prismaServiceMock.job.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: {
        status: JobStatus.error,
        errorMessage: "Error uploading files to S3.",
      },
    });
  });

  it("returns the job when it belongs to the user", async () => {
    prismaServiceMock.job.findFirst.mockResolvedValue({
      id: "job-1",
      userId: "user-1",
      status: JobStatus.pending,
    });

    await expect(service.findJobStatus("user-1", "job-1")).resolves.toEqual({
      id: "job-1",
      userId: "user-1",
      status: JobStatus.pending,
    });
  });
});
