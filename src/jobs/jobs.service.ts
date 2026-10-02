import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, JobInputSource, JobStatus } from "@prisma/client";
import { DynamoService, SessionSummary } from "../infrastructure/dynamo/dynamo.service";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { S3Service } from "../infrastructure/storage/s3.service";
import { ListJobsQueryDto } from "./dto/list-jobs-query.dto";
import { UploadJobDto } from "./dto/upload-job.dto";

type UploadedFile = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

type JobUploadFiles = {
  paciFile?: UploadedFile[];
  planningFile?: UploadedFile[];
};

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly s3Service: S3Service,
    private readonly dynamoService: DynamoService,
    private readonly configService: ConfigService,
  ) {}

  async createUploadJob(
    userId: string,
    dto: UploadJobDto,
    files: JobUploadFiles,
    colegioId: string | null = null,
  ): Promise<{ jobId: string; status: JobStatus }> {
    const prompt = dto.prompt?.trim() ?? "";

    const planningFile = files.planningFile?.[0];
    const paciFile = files.paciFile?.[0];

    if (!planningFile) {
      throw new BadRequestException("Planning file is required.");
    }

    const paciPayload = this.resolvePaciPayload(dto.paciJson, paciFile);
    const planningPayload = this.resolveDocumentPayload(
      planningFile,
      "Planning file",
    );

    const job = await this.prismaService.job.create({
      data: {
        userId,
        colegioId,
        status: JobStatus.pending,
        inputSource: paciPayload.inputSource,
        prompt,
        paciObjectKey: paciPayload.objectKey,
        paciFileName: paciPayload.fileName,
        paciContentType: paciPayload.contentType,
        planningObjectKey: planningPayload.objectKey,
        planningFileName: planningPayload.fileName,
        planningContentType: planningPayload.contentType,
      },
    });

    // Un solo flujo activo por docente: el cupo se reserva con el id del job (que es el id de la sesión).
    const cupo = await this.dynamoService.acquireUserSlot(userId, job.id);
    if (!cupo.acquired) {
      await this.prismaService.job.delete({ where: { id: job.id } });
      throw new ConflictException({
        statusCode: 409,
        code: "flow_in_progress",
        message: "Ya tienes un flujo en acción",
        session_id: cupo.activeSessionId ?? null,
      });
    }

    const paciS3Key = this.prefixedKey(job.id, paciPayload.objectKey);
    const materialS3Key = this.prefixedKey(job.id, planningPayload.objectKey);

    try {
      // DynamoDB must exist before S3 uploads — the Lambda fires on the first PUT
      // and needs to find the session record already in DynamoDB.
      await this.dynamoService.createJobSession(
        job.id,
        userId,
        paciS3Key,
        materialS3Key,
        prompt,
      );

      await this.s3Service.uploadObject({
        key: paciS3Key,
        body: paciPayload.body,
        contentType: paciPayload.contentType,
      });

      await this.s3Service.uploadObject({
        key: materialS3Key,
        body: planningPayload.body,
        contentType: planningPayload.contentType,
      });

      return { jobId: job.id, status: JobStatus.pending };
    } catch (error: unknown) {
      this.logger.error(
        `createUploadJob failed for job ${job.id}`,
        error instanceof Error ? error.stack : String(error),
      );

      await this.dynamoService.releaseUserSlot(userId, job.id);

      await this.prismaService.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.error,
          errorMessage:
            error instanceof Error
              ? error.message
              : "Error uploading files to S3.",
        },
      });

      throw error instanceof Error
        ? error
        : new Error("Unexpected error creating job upload.");
    }
  }

  async findJobsByUser(
    userId: string,
    query: ListJobsQueryDto,
  ): Promise<{
    items: Array<{
      id: string;
      status: JobStatus;
      inputSource: JobInputSource;
      prompt: string;
      createdAt: Date;
      updatedAt: Date;
      errorMessage: string | null;
    }>;
    page: number;
    limit: number;
    total: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const [total, jobs] = await Promise.all([
      this.prismaService.job.count({ where: { userId } }),
      this.prismaService.job.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          status: true,
          inputSource: true,
          prompt: true,
          createdAt: true,
          updatedAt: true,
          errorMessage: true,
        },
      }),
    ]);

    return { items: jobs, page, limit, total };
  }

  async getHistoryByUser(userId: string): Promise<SessionSummary[]> {
    return this.dynamoService.listSessionsByUser(userId);
  }

  async getActiveSession(userId: string): Promise<{
    active: { sessionId: string; phase: string; workflowStatus: string | null } | null;
  }> {
    return { active: await this.dynamoService.getActiveSession(userId) };
  }

  async findJobStatus(userId: string, jobId: string): Promise<Job> {
    const job = await this.findOwnedJob(userId, jobId);
    return job;
  }

  async getDownloadUrl(
    userId: string,
    jobId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const job = await this.findOwnedJob(userId, jobId);

    if (job.status !== JobStatus.done) {
      throw new BadRequestException("Job is not ready for download.");
    }

    if (!job.generatedObjectKey) {
      throw new UnprocessableEntityException(
        "Generated object key is missing for this job.",
      );
    }

    const expiresInSeconds = this.configService.get<number>(
      "PACI_DOCUMENTS_URL_EXPIRES_IN",
      900,
    );

    return {
      url: await this.s3Service.createSignedDownloadUrl(
        job.generatedObjectKey,
        expiresInSeconds,
      ),
      expiresInSeconds,
    };
  }

  private async findOwnedJob(userId: string, jobId: string): Promise<Job> {
    const job = await this.prismaService.job.findFirst({
      where: { id: jobId, userId },
    });

    if (!job) {
      throw new NotFoundException("Job not found.");
    }

    return job;
  }

  private resolvePaciPayload(
    paciJson: string | undefined,
    paciFile: UploadedFile | undefined,
  ): {
    body: Buffer;
    contentType: string;
    fileName: string;
    objectKey: string;
    inputSource: JobInputSource;
  } {
    if (paciJson && paciFile) {
      throw new BadRequestException(
        "Send either paciJson or paciFile, not both.",
      );
    }

    if (paciJson) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(paciJson);
      } catch {
        throw new BadRequestException("paciJson must be valid JSON.");
      }

      return {
        body: Buffer.from(JSON.stringify(parsed, null, 2), "utf8"),
        contentType: "application/json",
        fileName: "paci.json",
        objectKey: "paci.json",
        inputSource: JobInputSource.json_form,
      };
    }

    if (!paciFile) {
      throw new BadRequestException("Either paciJson or paciFile is required.");
    }

    this.assertAllowedDocument(
      paciFile.originalname,
      paciFile.mimetype,
      "PACI file",
    );

    const ext = this.getExtension(paciFile.originalname);
    return {
      body: paciFile.buffer,
      contentType: this.normalizeContentType(paciFile.mimetype),
      fileName: paciFile.originalname,
      objectKey: `paci${ext}`,
      inputSource: JobInputSource.uploaded_file,
    };
  }

  private resolveDocumentPayload(
    file: UploadedFile,
    fieldName: string,
  ): {
    body: Buffer;
    contentType: string;
    fileName: string;
    objectKey: string;
  } {
    this.assertAllowedDocument(file.originalname, file.mimetype, fieldName);

    const ext = this.getExtension(file.originalname);
    return {
      body: file.buffer,
      contentType: this.normalizeContentType(file.mimetype),
      fileName: file.originalname,
      objectKey: `material${ext}`,
    };
  }

  private assertAllowedDocument(
    fileName: string,
    mimeType: string,
    fieldName: string,
  ): void {
    const normalizedMimeType = this.normalizeContentType(mimeType);
    const normalizedFileName = fileName.toLowerCase();
    const isPdf =
      normalizedMimeType === "application/pdf" ||
      normalizedFileName.endsWith(".pdf");
    const isDocx =
      normalizedMimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      normalizedFileName.endsWith(".docx");

    if (!isPdf && !isDocx) {
      throw new BadRequestException(
        `${fieldName} must be a PDF or DOCX document.`,
      );
    }
  }

  private normalizeContentType(contentType: string): string {
    return contentType.toLowerCase();
  }

  private getExtension(fileName: string): string {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".pdf")) return ".pdf";
    if (lower.endsWith(".docx")) return ".docx";
    return ".pdf";
  }

  private sanitizeFileName(fileName: string): string {
    return fileName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  }

  private prefixedKey(jobId: string, objectKey: string): string {
    return `jobs/${jobId}/${objectKey}`;
  }

  async getStatsByColegio(colegioId: string): Promise<{
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    pendingJobs: number;
    processingJobs: number;
  }> {
    const [totalJobs, completedJobs, failedJobs, pendingJobs, processingJobs] = await Promise.all([
      this.prismaService.job.count({ where: { colegioId } }),
      this.prismaService.job.count({ where: { colegioId, status: JobStatus.done } }),
      this.prismaService.job.count({ where: { colegioId, status: JobStatus.error } }),
      this.prismaService.job.count({ where: { colegioId, status: JobStatus.pending } }),
      this.prismaService.job.count({ where: { colegioId, status: JobStatus.processing } }),
    ]);

    return { totalJobs, completedJobs, failedJobs, pendingJobs, processingJobs };
  }

  async getJobsByColegio(
    colegioId: string,
    query: ListJobsQueryDto,
  ): Promise<{
    items: Array<{
      id: string;
      userId: string;
      status: JobStatus;
      inputSource: JobInputSource;
      prompt: string;
      createdAt: Date;
      updatedAt: Date;
      errorMessage: string | null;
    }>;
    page: number;
    limit: number;
    total: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const [total, jobs] = await Promise.all([
      this.prismaService.job.count({ where: { colegioId } }),
      this.prismaService.job.findMany({
        where: { colegioId },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          userId: true,
          status: true,
          inputSource: true,
          prompt: true,
          createdAt: true,
          updatedAt: true,
          errorMessage: true,
        },
      }),
    ]);

    return { items: jobs, page, limit, total };
  }
}
