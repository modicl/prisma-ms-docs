import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type UploadObjectInput = {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
  metadata?: Record<string, string>;
};

@Injectable()
export class S3Service {
  private client?: S3Client;

  constructor(private readonly configService: ConfigService) {}

  async uploadObject(
    input: UploadObjectInput,
  ): Promise<{ bucket: string; key: string }> {
    const { bucket, client } = this.getClientAndBucket();

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          Metadata: input.metadata,
        }),
      );

      return { bucket, key: input.key };
    } catch (error: unknown) {
      throw new InternalServerErrorException(
        error instanceof Error
          ? error.message
          : "Could not upload object to S3.",
      );
    }
  }

  async createSignedDownloadUrl(
    key: string,
    expiresInSeconds = 900,
  ): Promise<string> {
    const { bucket, client } = this.getClientAndBucket();
    // Solo desarrollo local: LocalStack se alcanza internamente como `localstack:4566`, un nombre que el navegador del docente no
    // resuelve. Con AWS_S3_PUBLIC_ENDPOINT la URL se firma con una dirección alcanzable. En AWS real la variable no existe.
    const firmante = this.configService.get<string>("AWS_S3_PUBLIC_ENDPOINT")
      ? this.buildClient(this.configService.get<string>("AWS_S3_PUBLIC_ENDPOINT"))
      : client;

    try {
      return await getSignedUrl(
        firmante,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    } catch (error: unknown) {
      throw new InternalServerErrorException(
        error instanceof Error
          ? error.message
          : "Could not create S3 download URL.",
      );
    }
  }

  private buildClient(endpoint?: string): S3Client {
    const region = this.configService.get<string>("AWS_REGION");
    const accessKeyId = this.configService.get<string>("AWS_ACCESS_KEY_ID");
    const secretAccessKey = this.configService.get<string>("AWS_SECRET_ACCESS_KEY");
    const forcePathStyle = this.configService.get<string>("AWS_S3_FORCE_PATH_STYLE") === "true";

    if (!region) {
      throw new Error("AWS_REGION is required for S3 operations.");
    }

    // Without explicit keys we fall back to the SDK default credential chain,
    // which on ECS resolves the task role via the container metadata endpoint.
    return new S3Client({
      region,
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle,
    });
  }

  private getClientAndBucket(): { bucket: string; client: S3Client } {
    if (!this.client) {
      this.client = this.buildClient(this.configService.get<string>("AWS_S3_ENDPOINT"));
    }

    const bucket =
      this.configService.get<string>("S3_BUCKET") ??
      this.configService.get<string>("PACI_DOCUMENTS_BUCKET");

    if (!bucket) {
      throw new Error("S3_BUCKET is required for S3 operations.");
    }

    return { bucket, client: this.client };
  }
}
