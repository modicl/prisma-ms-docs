import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { CognitoAuthGuard } from "../auth/guards/cognito-auth.guard";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";

jest.mock("jose", () => ({
  createRemoteJWKSet: jest.fn(() => "jwks"),
  jwtVerify: jest.fn(),
}));

describe("JobsController", () => {
  const jobsServiceMock = {
    createUploadJob: jest.fn(),
    findJobsByUser: jest.fn(),
    findJobStatus: jest.fn(),
    getDownloadUrl: jest.fn(),
  };

  let controller: JobsController;

  beforeEach(async () => {
    jobsServiceMock.createUploadJob.mockReset();
    jobsServiceMock.findJobsByUser.mockReset();
    jobsServiceMock.findJobStatus.mockReset();
    jobsServiceMock.getDownloadUrl.mockReset();

    const moduleRef = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [
        { provide: JobsService, useValue: jobsServiceMock },
      ],
    })
      .overrideGuard(CognitoAuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = moduleRef.get(JobsController);
  });

  it("forwards request.user.id to the jobs service on upload", async () => {
    jobsServiceMock.createUploadJob.mockResolvedValue({
      jobId: "job-123",
      status: "pending",
    });

    const result = await controller.upload(
      {
        user: { id: "user-456" },
      } as never,
      {
        prompt: "  revisar esto  ",
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
    );

    expect(result).toEqual({ jobId: "job-123", status: "pending" });
    expect(jobsServiceMock.createUploadJob).toHaveBeenCalledWith(
      "user-456",
      { prompt: "  revisar esto  " },
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
      undefined,
    );
  });

  it("rejects upload requests without an authenticated user", async () => {
    await expect(
      controller.upload({} as never, { prompt: "hola" } as never, {
        planningFile: [
          {
            originalname: "plan.docx",
            mimetype:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            buffer: Buffer.from("planning"),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(jobsServiceMock.createUploadJob).not.toHaveBeenCalled();
  });
});
