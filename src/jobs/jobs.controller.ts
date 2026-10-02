import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { Request } from "express";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { CognitoAuthGuard } from "../auth/guards/cognito-auth.guard";
import { ListJobsQueryDto } from "./dto/list-jobs-query.dto";
import { UploadJobDto } from "./dto/upload-job.dto";
import { JobsService } from "./jobs.service";

const ADMIN_ROLES = ["ADMIN", "SUPERADMIN"];

type UploadedFile = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

type RequestWithUser = Request & {
  user?: { id?: string; role?: string; colegioId?: string | null };
};

@ApiTags("jobs")
@Controller("jobs")
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @UseGuards(CognitoAuthGuard)
  @Post("upload")
  @ApiBearerAuth()
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Crear job PACI y subir archivos a S3" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        paciJson: { type: "string", description: "JSON del formulario UI web" },
        paciFile: { type: "string", format: "binary" },
        planningFile: { type: "string", format: "binary" },
      },
      required: ["prompt", "planningFile"],
    },
  })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "paciFile", maxCount: 1 },
        { name: "planningFile", maxCount: 1 },
      ],
      {
        limits: {
          fileSize: 25 * 1024 * 1024,
        },
      },
    ),
  )
  @ApiResponse({ status: 201, description: "Job creado correctamente." })
  async upload(
    @Req() request: RequestWithUser,
    @Body() dto: UploadJobDto,
    @UploadedFiles()
    files: {
      paciFile?: UploadedFile[];
      planningFile?: UploadedFile[];
    },
  ) {
    const user = request.user;

    if (!user?.id) {
      throw new BadRequestException("Authenticated user is required.");
    }

    return this.jobsService.createUploadJob(user.id, dto, files, user.colegioId);
  }

  @UseGuards(CognitoAuthGuard, RolesGuard)
  @Roles(...ADMIN_ROLES)
  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Historial paginado de jobs (solo ADMIN/SUPERADMIN)" })
  @ApiResponse({ status: 200, description: "Historial obtenido correctamente." })
  @ApiResponse({ status: 403, description: "Forbidden - requiere rol ADMIN o SUPERADMIN." })
  async findAll(@Req() request: RequestWithUser, @Query() query: ListJobsQueryDto) {
    const user = request.user;

    if (!user?.id) {
      throw new BadRequestException("Authenticated user is required.");
    }

    return this.jobsService.findJobsByUser(user.id, query);
  }

  @UseGuards(CognitoAuthGuard)
  @Get("history")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Historial de sesiones del docente (desde DynamoDB)" })
  @ApiResponse({ status: 200, description: "Historial obtenido correctamente." })
  async getHistory(@Req() request: RequestWithUser) {
    const user = request.user;
    if (!user?.id) throw new BadRequestException("Authenticated user is required.");
    return this.jobsService.getHistoryByUser(user.id);
  }

  // Debe ir ANTES de `:id`: si no, "active" se leería como un id de job.
  @UseGuards(CognitoAuthGuard)
  @Get("active")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Flujo activo del docente (para retomarlo), leído de su cupo" })
  @ApiResponse({ status: 200, description: "`{ active: {sessionId, phase, workflowStatus} | null }`." })
  async getActive(@Req() request: RequestWithUser) {
    const user = request.user;
    if (!user?.id) throw new BadRequestException("Authenticated user is required.");
    return this.jobsService.getActiveSession(user.id);
  }

  @UseGuards(CognitoAuthGuard)
  @Get(":id")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Estado actual de un job" })
  @ApiResponse({ status: 200, description: "Estado obtenido correctamente." })
  async findOne(
    @Req() request: RequestWithUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const user = request.user;

    if (!user?.id) {
      throw new BadRequestException("Authenticated user is required.");
    }

    return this.jobsService.findJobStatus(user.id, id);
  }

  @UseGuards(CognitoAuthGuard)
  @Get(":id/download")
  @ApiBearerAuth()
  @ApiOperation({ summary: "URL firmada para descargar el documento generado" })
  @ApiResponse({ status: 200, description: "URL generada correctamente." })
  async download(
    @Req() request: RequestWithUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const user = request.user;

    if (!user?.id) {
      throw new BadRequestException("Authenticated user is required.");
    }

    return this.jobsService.getDownloadUrl(user.id, id);
  }

  @UseGuards(CognitoAuthGuard, RolesGuard)
  @Roles(...ADMIN_ROLES)
  @Get("colegio/:colegioId/stats")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Estadísticas de jobs por colegio (solo ADMIN/SUPERADMIN)" })
  @ApiResponse({ status: 200, description: "Estadísticas obtenidas correctamente." })
  @ApiResponse({ status: 403, description: "Forbidden - requiere rol ADMIN o SUPERADMIN." })
  async getColegioStats(
    @Req() request: RequestWithUser,
    @Param("colegioId", new ParseUUIDPipe()) colegioId: string,
  ) {
    const user = request.user;
    const userRole = user?.role;

    if (userRole === "ADMIN" && user?.colegioId !== colegioId) {
      throw new ForbiddenException(
        "ADMIN only puede consultar estadísticas de su propio colegio.",
      );
    }

    return this.jobsService.getStatsByColegio(colegioId);
  }

  @UseGuards(CognitoAuthGuard)
  @Get("colegio/:colegioId/jobs")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Jobs de un colegio específico" })
  @ApiResponse({ status: 200, description: "Jobs obtenidos correctamente." })
  async getColegioJobs(
    @Param("colegioId", new ParseUUIDPipe()) colegioId: string,
    @Query() query: ListJobsQueryDto,
  ) {
    return this.jobsService.getJobsByColegio(colegioId, query);
  }
}
