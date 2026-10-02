import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";

export interface SessionSummary {
  sessionId: string;
  phase: string;
  workflowStatus: string | null;
  prompt: string;
  createdAt: string;
  docxS3Key: string | null;
  error: string | null;
}

@Injectable()
export class DynamoService {
  private readonly logger = new Logger(DynamoService.name);
  private client?: DynamoDBClient;

  constructor(private readonly configService: ConfigService) {}

  async createJobSession(
    sessionId: string,
    userId: string,
    paciS3Key: string,
    materialS3Key: string,
    prompt: string,
    schoolId?: string,
  ): Promise<void> {
    const table =
      this.configService.get<string>("DYNAMO_TABLE") ??
      this.configService.get<string>("CHAT_SESSIONS_TABLE");

    if (!table) {
      throw new InternalServerErrorException(
        "DYNAMO_TABLE is required for job sessions.",
      );
    }

    const now = new Date().toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86400;

    try {
      await this.getClient().send(
        new PutItemCommand({
          TableName: table,
          Item: {
            session_id:      { S: sessionId },
            user_id:         { S: userId },
            phase:           { S: "running" },
            prompt:          { S: prompt },
            school_id:       { S: schoolId || "colegio_demo" },
            paci_s3_key:     { S: paciS3Key },
            material_s3_key: { S: materialS3Key },
            messages:        { S: "[]" },
            hitl_data:       { S: "null" },
            error:           { S: "" },
            docx_s3_key:     { S: "" },
            workflow_status: { S: "" },
            created_at:      { S: now },
            updated_at:      { S: now },
            expires_at:      { N: String(expiresAt) },
          },
          ConditionExpression: "attribute_not_exists(session_id)",
        }),
      );
      this.logger.log(`Session created in DynamoDB: ${sessionId} (table=${table})`);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        this.logger.warn(`Session ${sessionId} already exists in DynamoDB — skipping write`);
        return;
      }
      this.logger.error(
        `DynamoDB PutItem failed for session ${sessionId} — table=${table} region=${this.configService.get("AWS_REGION")}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException(
        error instanceof Error ? error.message : "Error writing session to DynamoDB.",
      );
    }
  }

  // ── Un solo flujo activo por docente ────────────────────────────────────────────────────────────────────
  // Mismo registro que usa el workflow (`user#{id}` en la misma tabla): reserva atómica con escritura condicional.
  // Vence solo (active_until) para que un flujo atascado no bloquee al docente; el TTL de DynamoDB limpia el registro después.
  async acquireUserSlot(
    userId: string,
    sessionId: string,
    ttlSeconds = 600,
  ): Promise<{ acquired: boolean; activeSessionId?: string }> {
    const table = this.table();
    const now = Math.floor(Date.now() / 1000);
    try {
      await this.getClient().send(
        new PutItemCommand({
          TableName: table,
          Item: {
            session_id:     { S: `user#${userId}` },
            active_session: { S: sessionId },
            active_until:   { N: String(now + ttlSeconds) },
            expires_at:     { N: String(now + ttlSeconds + 3600) },
          },
          ConditionExpression: "attribute_not_exists(session_id) OR active_until < :now",
          ExpressionAttributeValues: { ":now": { N: String(now) } },
        }),
      );
      return { acquired: true };
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw new InternalServerErrorException(
          error instanceof Error ? error.message : "Error reservando el cupo de flujo.",
        );
      }
    }
    const actual = await this.getClient().send(
      new GetItemCommand({ TableName: table, Key: { session_id: { S: `user#${userId}` } } }),
    );
    return { acquired: false, activeSessionId: actual.Item?.active_session?.S };
  }

  /** Libera el cupo solo si sigue siendo de esa sesión (no borra el de un flujo posterior). Nunca lanza. */
  async releaseUserSlot(userId: string, sessionId: string): Promise<void> {
    try {
      await this.getClient().send(
        new DeleteItemCommand({
          TableName: this.table(),
          Key: { session_id: { S: `user#${userId}` } },
          ConditionExpression: "active_session = :sid",
          ExpressionAttributeValues: { ":sid": { S: sessionId } },
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        this.logger.error(`No se pudo liberar el cupo de ${userId}`, error instanceof Error ? error.stack : String(error));
      }
    }
  }

  /**
   * Flujo activo del docente, para que pueda retomarlo si cerró el navegador o perdió la conexión.
   * SOLO lectura (dos GetItem): lee su cupo `user#{id}` y la sesión a la que apunta. Un cupo vencido o una sesión ya
   * terminada no cuentan como activos (no se limpian desde aquí).
   */
  async getActiveSession(
    userId: string,
  ): Promise<{ sessionId: string; phase: string; workflowStatus: string | null } | null> {
    const table = this.table();
    const cupo = await this.getClient().send(
      new GetItemCommand({ TableName: table, Key: { session_id: { S: `user#${userId}` } } }),
    );
    const sessionId = cupo.Item?.active_session?.S;
    const hasta = Number(cupo.Item?.active_until?.N ?? 0);
    if (!sessionId || hasta < Math.floor(Date.now() / 1000)) return null;

    const sesion = await this.getClient().send(
      new GetItemCommand({
        TableName: table,
        Key: { session_id: { S: sessionId } },
        ProjectionExpression: "#ph, workflow_status",
        ExpressionAttributeNames: { "#ph": "phase" },
      }),
    );
    const phase = sesion.Item?.phase?.S;
    if (!phase || phase === "completed" || phase === "error") return null;
    return { sessionId, phase, workflowStatus: sesion.Item?.workflow_status?.S || null };
  }

  private table(): string {
    const table =
      this.configService.get<string>("DYNAMO_TABLE") ??
      this.configService.get<string>("CHAT_SESSIONS_TABLE");
    if (!table) {
      throw new InternalServerErrorException("DYNAMO_TABLE is required for job sessions.");
    }
    return table;
  }

  async listSessionsByUser(userId: string): Promise<SessionSummary[]> {
    const table =
      this.configService.get<string>("DYNAMO_TABLE") ??
      this.configService.get<string>("CHAT_SESSIONS_TABLE");

    if (!table) {
      this.logger.warn("DYNAMO_TABLE not set — returning empty history");
      return [];
    }

    try {
      const result = await this.getClient().send(
        new ScanCommand({
          TableName: table,
          FilterExpression: "user_id = :uid",
          ExpressionAttributeValues: { ":uid": { S: userId } },
          ProjectionExpression:
            "session_id, #ph, workflow_status, prompt, created_at, docx_s3_key, #er",
          ExpressionAttributeNames: { "#ph": "phase", "#er": "error" },
        }),
      );

      return (result.Items ?? [])
        .map((item) => ({
          sessionId:      item.session_id?.S ?? "",
          phase:          item["#ph"]?.S ?? item.phase?.S ?? "running",
          workflowStatus: item.workflow_status?.S || null,
          prompt:         item.prompt?.S ?? "",
          createdAt:      item.created_at?.S ?? "",
          docxS3Key:      item.docx_s3_key?.S || null,
          error:          (item["#er"]?.S ?? item.error?.S) || null,
        }))
        .filter((s) => s.sessionId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (err) {
      this.logger.error("DynamoDB scan failed", err instanceof Error ? err.stack : String(err));
      return [];
    }
  }

  private getClient(): DynamoDBClient {
    if (!this.client) {
      const region = this.configService.get<string>("AWS_REGION");
      const accessKeyId = this.configService.get<string>("AWS_ACCESS_KEY_ID");
      const secretAccessKey = this.configService.get<string>(
        "AWS_SECRET_ACCESS_KEY",
      );
      const endpoint = this.configService.get<string>("AWS_DYNAMODB_ENDPOINT");

      if (!region) {
        throw new InternalServerErrorException(
          "AWS_REGION is required for DynamoDB operations.",
        );
      }

      // Without explicit keys we fall back to the SDK default credential chain,
      // which on ECS resolves the task role via the container metadata endpoint.
      this.client = new DynamoDBClient({
        region,
        ...(accessKeyId && secretAccessKey
          ? { credentials: { accessKeyId, secretAccessKey } }
          : {}),
        ...(endpoint ? { endpoint } : {}),
      });
    }
    return this.client;
  }
}
