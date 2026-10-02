import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JobStatus } from "@prisma/client";
import { JobsService } from "./jobs.service";
import { DynamoService } from "../infrastructure/dynamo/dynamo.service";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { S3Service } from "../infrastructure/storage/s3.service";

describe("JobsService", () => {
  const configServiceMock = {
    get: jest.fn(),
  };

  const prismaServiceMock = {
    job: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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
    getActiveSession: jest.fn(),
  };

  let service: JobsService;

  beforeEach(() => {
    jest.clearAllMocks();

    configServiceMock.get.mockImplementation(
      (key: string, defaultValue?: unknown) => {
        if (key === "PACI_DOCUMENTS_URL_EXPIRES_IN") {
          return 900;
        }

        return defaultValue;
      },
    );

    prismaServiceMock.job.create.mockResolvedValue({
      id: "job-123",
    });
    prismaServiceMock.job.update.mockResolvedValue({});
    s3ServiceMock.uploadObject.mockResolvedValue({
      bucket: "bucket",
      key: "key",
    });
    dynamoServiceMock.createJobSession.mockResolvedValue(undefined);
    dynamoServiceMock.acquireUserSlot.mockResolvedValue({ acquired: true });
    dynamoServiceMock.releaseUserSlot.mockResolvedValue(undefined);
    prismaServiceMock.job.delete.mockResolvedValue({});

    service = new JobsService(
      prismaServiceMock as unknown as PrismaService,
      s3ServiceMock as unknown as S3Service,
      dynamoServiceMock as unknown as DynamoService,
      configServiceMock as unknown as ConfigService,
    );
  });

  it("forwards the authenticated userId to DynamoDB", async () => {
    await expect(
      service.createUploadJob(
        "user-456",
        {
          prompt: "  revisar esto  ",
          paciJson: JSON.stringify({ foo: "bar" }),
        } as never,
        {
          planningFile: [
            {
              originalname: "plan.docx",
              mimetype:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              buffer: Buffer.from("planning"),
            },
          ],
        },
      ),
    ).resolves.toEqual({ jobId: "job-123", status: JobStatus.pending });

    expect(prismaServiceMock.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-456",
        prompt: "revisar esto",
      }),
    });

    expect(dynamoServiceMock.createJobSession).toHaveBeenCalledWith(
      "job-123",
      "user-456",
      "jobs/job-123/paci.json",
      "jobs/job-123/material.docx",
      "revisar esto",
    );
  });

  const archivos = {
    planningFile: [
      {
        originalname: "plan.docx",
        mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: Buffer.from("planning"),
      },
    ],
  };
  const dto = { prompt: "x", paciJson: JSON.stringify({ a: 1 }) } as never;

  it("reserva el cupo del docente con el id del job", async () => {
    await service.createUploadJob("user-456", dto, archivos);
    expect(dynamoServiceMock.acquireUserSlot).toHaveBeenCalledWith("user-456", "job-123");
  });

  it("si ya tiene un flujo activo responde 409, borra el job y no escribe nada", async () => {
    dynamoServiceMock.acquireUserSlot.mockResolvedValue({ acquired: false, activeSessionId: "activa-1" });
    const error = await service.createUploadJob("user-456", dto, archivos).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      code: "flow_in_progress",
      message: "Ya tienes un flujo en acción",
      session_id: "activa-1",
    });
    expect(prismaServiceMock.job.delete).toHaveBeenCalledWith({ where: { id: "job-123" } });
    expect(dynamoServiceMock.createJobSession).not.toHaveBeenCalled();
    expect(s3ServiceMock.uploadObject).not.toHaveBeenCalled();
  });

  it("si falla la subida a S3 libera el cupo", async () => {
    s3ServiceMock.uploadObject.mockRejectedValueOnce(new Error("s3 caido"));
    await expect(service.createUploadJob("user-456", dto, archivos)).rejects.toThrow("s3 caido");
    expect(dynamoServiceMock.releaseUserSlot).toHaveBeenCalledWith("user-456", "job-123");
  });

  it("getActiveSession envuelve la sesión activa del docente", async () => {
    dynamoServiceMock.getActiveSession.mockResolvedValue({ sessionId: "s1", phase: "running", workflowStatus: null });
    await expect(service.getActiveSession("user-456")).resolves.toEqual({
      active: { sessionId: "s1", phase: "running", workflowStatus: null },
    });
    expect(dynamoServiceMock.getActiveSession).toHaveBeenCalledWith("user-456");
  });

  it("getActiveSession devuelve active null si no hay flujo activo", async () => {
    dynamoServiceMock.getActiveSession.mockResolvedValue(null);
    await expect(service.getActiveSession("user-456")).resolves.toEqual({ active: null });
  });
});
