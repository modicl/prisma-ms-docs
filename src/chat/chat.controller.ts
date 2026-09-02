import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiBadRequestResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { Request } from "express";
import { StartChatDto } from "./dto/start-chat.dto";
import { ChatService } from "./chat.service";
import { CognitoAuthGuard } from "../auth/guards/cognito-auth.guard";

type UploadedFile = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

type RequestWithUser = Request & { user?: { id?: string; colegioId?: string | null } };

@ApiTags("chat")
@Controller("chat")
@UseGuards(CognitoAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post("start")
  @HttpCode(201)
  @ApiBearerAuth()
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Iniciar sesión de chat PACI con archivos" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        paci_file: { type: "string", format: "binary" },
        material_file: { type: "string", format: "binary" },
        prompt: { type: "string", description: "Texto opcional" },
        school_id: {
          type: "string",
          default: "colegio_demo",
          description: "Identificador del colegio",
        },
      },
      required: ["paci_file", "material_file"],
    },
  })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "paci_file", maxCount: 1 },
        { name: "material_file", maxCount: 1 },
      ],
      {
        limits: {
          fileSize: 25 * 1024 * 1024,
        },
      },
    ),
  )
  @ApiCreatedResponse({
    description: "Sesión creada correctamente.",
    schema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          example: "259147af-053d-4e5b-8ac4-d50e8a0fc786",
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: "Faltan archivos o el payload multipart es inválido.",
  })
  @ApiResponse({ status: 201, description: "Sesión creada correctamente." })
  async startChat(
    @Req() request: RequestWithUser,
    @UploadedFiles()
    files: {
      paci_file?: UploadedFile[];
      material_file?: UploadedFile[];
    },
    @Body() dto: StartChatDto,
  ): Promise<{ session_id: string }> {
    const user = request.user;
    if (!user?.id) {
      throw new BadRequestException("Authenticated user is required.");
    }

    const paciFile = files.paci_file?.[0];
    const materialFile = files.material_file?.[0];

    if (!paciFile || !materialFile) {
      throw new BadRequestException("paci_file and material_file are required.");
    }

    return this.chatService.startChat({
      userId: user.id,
      paciFile,
      materialFile,
      prompt: dto.prompt ?? "",
      schoolId: dto.school_id ?? user.colegioId ?? "colegio_demo",
    });
  }
}
