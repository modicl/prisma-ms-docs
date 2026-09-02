import { CanActivate, ExecutionContext, INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppController } from "../src/app.controller";
import { ChatController } from "../src/chat/chat.controller";
import { ChatService } from "../src/chat/chat.service";
import { JobsController } from "../src/jobs/jobs.controller";
import { JobsService } from "../src/jobs/jobs.service";
import { CognitoAuthGuard } from "../src/auth/guards/cognito-auth.guard";
import { RolesGuard } from "../src/auth/guards/roles.guard";

jest.mock("jose", () => ({
  createRemoteJWKSet: jest.fn(() => "jwks"),
  jwtVerify: jest.fn(),
}));

class TestCognitoAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: { id: string } }>();
    request.user = { id: "teacher-1" };
    return true;
  }
}

describe("App e2e", () => {
  let app: INestApplication;

  const chatServiceMock = {
    startChat: jest.fn(),
  };

  const jobsServiceMock = {
    createUploadJob: jest.fn(),
    findJobsByUser: jest.fn(),
    findJobStatus: jest.fn(),
    getDownloadUrl: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AppController, ChatController, JobsController],
      providers: [
        { provide: ChatService, useValue: chatServiceMock },
        { provide: JobsService, useValue: jobsServiceMock },
      ],
    })
      .overrideGuard(CognitoAuthGuard)
      .useClass(TestCognitoAuthGuard)
      // El endpoint de listado usa también RolesGuard; en e2e lo dejamos pasar
      // (el control de roles se prueba de forma unitaria en roles.guard.spec).
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    chatServiceMock.startChat.mockReset();
    jobsServiceMock.createUploadJob.mockReset();
    jobsServiceMock.findJobsByUser.mockReset();
    jobsServiceMock.findJobStatus.mockReset();
    jobsServiceMock.getDownloadUrl.mockReset();
  });

  it("serves health and the chat start endpoint", async () => {
    chatServiceMock.startChat.mockResolvedValue({
      session_id: "session-123",
    });

    await request(app.getHttpServer())
      .get("/api/health")
      .expect(200)
      .expect({ status: "ok" });

    const response = await request(app.getHttpServer())
      .post("/api/chat/start")
      .field("prompt", "resume esto")
      .field("school_id", "colegio_1")
      .attach("paci_file", Buffer.from("dummy pdf"), "paci.pdf")
      .attach("material_file", Buffer.from("dummy docx"), "material.docx")
      .expect(201);

    expect(response.body).toEqual({ session_id: "session-123" });
    expect(chatServiceMock.startChat).toHaveBeenCalledWith({
      userId: "teacher-1",
      paciFile: expect.objectContaining({
        originalname: "paci.pdf",
        mimetype: "application/pdf",
      }),
      materialFile: expect.objectContaining({
        originalname: "material.docx",
        mimetype:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      prompt: "resume esto",
      schoolId: "colegio_1",
    });
  });

  it("rejects chat start requests without required files", async () => {
    await request(app.getHttpServer())
      .post("/api/chat/start")
      .field("prompt", "sin archivos")
      .expect(400);

    expect(chatServiceMock.startChat).not.toHaveBeenCalled();
  });

  it("creates a job through the upload endpoint", async () => {
    jobsServiceMock.createUploadJob.mockResolvedValue({
      jobId: "11111111-1111-1111-1111-111111111111",
      status: "pending",
    });

    const response = await request(app.getHttpServer())
      .post("/api/jobs/upload")
      .field("prompt", "preparar clase")
      .field("paciJson", JSON.stringify({ topic: "lectura" }))
      .attach("planningFile", Buffer.from("planning pdf"), "planning.pdf")
      .expect(201);

    expect(response.body).toEqual({
      jobId: "11111111-1111-1111-1111-111111111111",
      status: "pending",
    });
    expect(jobsServiceMock.createUploadJob).toHaveBeenCalledWith(
      "teacher-1",
      expect.objectContaining({
        prompt: "preparar clase",
        paciJson: JSON.stringify({ topic: "lectura" }),
      }),
      expect.objectContaining({
        planningFile: expect.arrayContaining([
          expect.objectContaining({
            originalname: "planning.pdf",
            mimetype: "application/pdf",
          }),
        ]),
      }),
      undefined,
    );
  });

  it("lists jobs for the authenticated user", async () => {
    jobsServiceMock.findJobsByUser.mockResolvedValue({
      items: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          status: "pending",
          inputSource: "json_form",
          prompt: "preparar clase",
          createdAt: new Date("2026-04-21T10:00:00.000Z"),
          updatedAt: new Date("2026-04-21T10:00:00.000Z"),
          errorMessage: null,
        },
      ],
      page: 1,
      limit: 10,
      total: 1,
    });

    await request(app.getHttpServer())
      .get("/api/jobs?page=1&limit=10")
      .expect(200)
      .expect({
        items: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            status: "pending",
            inputSource: "json_form",
            prompt: "preparar clase",
            createdAt: "2026-04-21T10:00:00.000Z",
            updatedAt: "2026-04-21T10:00:00.000Z",
            errorMessage: null,
          },
        ],
        page: 1,
        limit: 10,
        total: 1,
      });

    expect(jobsServiceMock.findJobsByUser).toHaveBeenCalledWith("teacher-1", {
      page: 1,
      limit: 10,
    });
  });

  it("returns the job status by id", async () => {
    jobsServiceMock.findJobStatus.mockResolvedValue({
      id: "33333333-3333-3333-3333-333333333333",
      userId: "teacher-1",
      status: "done",
      inputSource: "uploaded_file",
      prompt: "finalizar",
      paciObjectKey: "jobs/333/paci/paci.pdf",
      paciFileName: "paci.pdf",
      paciContentType: "application/pdf",
      planningObjectKey: "jobs/333/planning/planning.pdf",
      planningFileName: "planning.pdf",
      planningContentType: "application/pdf",
      generatedObjectKey: "jobs/333/generated/output.pdf",
      generatedFileName: "output.pdf",
      generatedContentType: "application/pdf",
      errorMessage: null,
      createdAt: new Date("2026-04-21T10:00:00.000Z"),
      updatedAt: new Date("2026-04-21T10:01:00.000Z"),
    });

    const response = await request(app.getHttpServer())
      .get("/api/jobs/33333333-3333-3333-3333-333333333333")
      .expect(200);

    expect(response.body.id).toBe("33333333-3333-3333-3333-333333333333");
    expect(response.body.status).toBe("done");

    expect(jobsServiceMock.findJobStatus).toHaveBeenCalledWith(
      "teacher-1",
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("returns a signed download url for finished jobs", async () => {
    jobsServiceMock.getDownloadUrl.mockResolvedValue({
      url: "https://signed.example/download",
      expiresInSeconds: 900,
    });

    await request(app.getHttpServer())
      .get("/api/jobs/33333333-3333-3333-3333-333333333333/download")
      .expect(200)
      .expect({
        url: "https://signed.example/download",
        expiresInSeconds: 900,
      });

    expect(jobsServiceMock.getDownloadUrl).toHaveBeenCalledWith(
      "teacher-1",
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("rejects invalid job ids before reaching the service", async () => {
    await request(app.getHttpServer())
      .get("/api/jobs/not-a-uuid")
      .expect(400);

    expect(jobsServiceMock.findJobStatus).not.toHaveBeenCalled();
  });
});