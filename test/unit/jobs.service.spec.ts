import {
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JobStatus } from "@prisma/client";
import { DynamoService } from "../../src/infrastructure/dynamo/dynamo.service";
import { PrismaService } from "../../src/infrastructure/prisma/prisma.service";
import { S3Service } from "../../src/infrastructure/storage/s3.service";
import { JobsService } from "../../src/jobs/jobs.service";

describe("JobsService", () => {
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
    acquireUserSlot: jest.fn(),
    releaseUserSlot: jest.fn(),
    createJobSession: jest.fn(),
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
    prismaServiceMock.job.count.mockResolvedValue(0);
    prismaServiceMock.job.findMany.mockResolvedValue([]);

    s3ServiceMock.uploadObject.mockResolvedValue({ bucket: "b", key: "k" });
    s3ServiceMock.createSignedDownloadUrl.mockResolvedValue("https://signed");
    dynamoServiceMock.createJobSession.mockResolvedValue(undefined);
    dynamoServiceMock.listSessionsByUser.mockResolvedValue([]);
    dynamoServiceMock.acquireUserSlot.mockResolvedValue({ acquired: true });
    dynamoServiceMock.releaseUserSlot.mockResolvedValue(undefined);

    service = new JobsService(
      prismaServiceMock as unknown as PrismaService,
      s3ServiceMock as unknown as S3Service,
      dynamoServiceMock as unknown as DynamoService,
      configServiceMock as unknown as ConfigService,
    );
  });

  it("requires the planning file", async () => {
    await expect(
      service.createUploadJob("user-1", { prompt: "hola" }, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects paciJson and paciFile together", async () => {
    await expect(
      service.createUploadJob(
        "user-1",
        { paciJson: "{}" },
        {
          paciFile: [
            {
              originalname: "paci.pdf",
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
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects invalid paciJson", async () => {
    await expect(
      service.createUploadJob(
        "user-1",
        { paciJson: "{invalid" },
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
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("uploads paciJson and planning file", async () => {
    await expect(
      service.createUploadJob(
        "user-1",
        { paciJson: "{\"topic\":\"lectura\"}" },
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
    ).resolves.toEqual({ jobId: "job-1", status: JobStatus.pending });

    expect(dynamoServiceMock.createJobSession).toHaveBeenCalledWith(
      "job-1",
      "user-1",
      "jobs/job-1/paci.json",
      "jobs/job-1/material.docx",
      "",
    );
    expect(s3ServiceMock.uploadObject).toHaveBeenCalledTimes(2);
  });

  it("returns paginated jobs for the user", async () => {
    prismaServiceMock.job.count.mockResolvedValue(5);
    prismaServiceMock.job.findMany.mockResolvedValue([
      {
        id: "job-1",
        status: JobStatus.pending,
        inputSource: "json_form",
        prompt: "hola",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        errorMessage: null,
      },
    ]);

    const result = await service.findJobsByUser("user-1", { page: 2, limit: 2 });

    expect(result.total).toBe(5);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(2);
    expect(prismaServiceMock.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 2, take: 2 }),
    );
  });

  it("returns download url for finished jobs", async () => {
    prismaServiceMock.job.findFirst.mockResolvedValue({
      id: "job-1",
      userId: "user-1",
      status: JobStatus.done,
      generatedObjectKey: "jobs/job-1/generated.pdf",
    });
    configServiceMock.get.mockReturnValue(1200);

    await expect(service.getDownloadUrl("user-1", "job-1")).resolves.toEqual({
      url: "https://signed",
      expiresInSeconds: 1200,
    });

    expect(s3ServiceMock.createSignedDownloadUrl).toHaveBeenCalledWith(
      "jobs/job-1/generated.pdf",
      1200,
    );
  });

  it("rejects download when job is not done", async () => {
    prismaServiceMock.job.findFirst.mockResolvedValue({
      id: "job-1",
      userId: "user-1",
      status: JobStatus.pending,
      generatedObjectKey: null,
    });

    await expect(service.getDownloadUrl("user-1", "job-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects download when generated key is missing", async () => {
    prismaServiceMock.job.findFirst.mockResolvedValue({
      id: "job-1",
      userId: "user-1",
      status: JobStatus.done,
      generatedObjectKey: null,
    });

    await expect(service.getDownloadUrl("user-1", "job-1")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
