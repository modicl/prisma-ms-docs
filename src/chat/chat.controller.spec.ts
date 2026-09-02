import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { CognitoAuthGuard } from "../auth/guards/cognito-auth.guard";

jest.mock("jose", () => ({
  createRemoteJWKSet: jest.fn(() => "jwks"),
  jwtVerify: jest.fn(),
}));

describe("ChatController", () => {
  const chatServiceMock = {
    startChat: jest.fn(),
  };

  let controller: ChatController;

  beforeEach(async () => {
    chatServiceMock.startChat.mockReset();

    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: chatServiceMock }],
    })
      .overrideGuard(CognitoAuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = moduleRef.get(ChatController);
  });

  it("forwards multipart files and dto values to the service", async () => {
    chatServiceMock.startChat.mockResolvedValue({
      session_id: "session-123",
    });

    const paciFile = {
      originalname: "paci.pdf",
      mimetype: "application/pdf",
      buffer: Buffer.from("paci"),
    };

    const materialFile = {
      originalname: "material.docx",
      mimetype:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("material"),
    };

    await expect(
      controller.startChat(
        { user: { id: "teacher-1" } } as any,
        {
          paci_file: [paciFile],
          material_file: [materialFile],
        },
        {
          prompt: "resume esto",
          school_id: "colegio_1",
        },
      ),
    ).resolves.toEqual({ session_id: "session-123" });

    expect(chatServiceMock.startChat).toHaveBeenCalledWith({
      userId: "teacher-1",
      paciFile,
      materialFile,
      prompt: "resume esto",
      schoolId: "colegio_1",
    });
  });

  it("rejects requests that omit required files", async () => {
    await expect(controller.startChat({ user: { id: "teacher-1" } } as any, {}, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(chatServiceMock.startChat).not.toHaveBeenCalled();
  });
});