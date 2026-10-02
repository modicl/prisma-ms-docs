import { InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Service } from "../../src/infrastructure/storage/s3.service";

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(),
}));

describe("S3Service", () => {
  const getSignedUrlMock = getSignedUrl as jest.Mock;
  const configServiceMock = {
    get: jest.fn(),
  };

  let service: S3Service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new S3Service(configServiceMock as unknown as ConfigService);
  });

  it("uploads an object to S3", async () => {
    const sendMock = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(service as any, "getClientAndBucket").mockReturnValue({
      bucket: "bucket-1",
      client: { send: sendMock },
    });

    await expect(
      service.uploadObject({
        key: "jobs/file.txt",
        body: "payload",
        contentType: "text/plain",
        metadata: { source: "unit-test" },
      }),
    ).resolves.toEqual({ bucket: "bucket-1", key: "jobs/file.txt" });

    expect(sendMock).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    const command = sendMock.mock.calls[0][0] as PutObjectCommand;
    expect(command.input).toEqual(
      expect.objectContaining({
        Bucket: "bucket-1",
        Key: "jobs/file.txt",
        ContentType: "text/plain",
        Metadata: { source: "unit-test" },
      }),
    );
  });

  it("wraps S3 upload failures", async () => {
    const sendMock = jest.fn().mockRejectedValue(new Error("boom"));
    jest.spyOn(service as any, "getClientAndBucket").mockReturnValue({
      bucket: "bucket-1",
      client: { send: sendMock },
    });

    await expect(
      service.uploadObject({
        key: "jobs/file.txt",
        body: "payload",
        contentType: "text/plain",
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it("creates signed download URLs", async () => {
    const sendMock = jest.fn();
    jest.spyOn(service as any, "getClientAndBucket").mockReturnValue({
      bucket: "bucket-1",
      client: { send: sendMock },
    });
    getSignedUrlMock.mockResolvedValue("https://signed-url");

    await expect(service.createSignedDownloadUrl("jobs/file.txt", 1200)).resolves
      .toBe("https://signed-url");

    expect(getSignedUrlMock).toHaveBeenCalledWith(
      { send: sendMock },
      expect.any(GetObjectCommand),
      { expiresIn: 1200 },
    );
  });

  it("wraps signed URL failures", async () => {
    const sendMock = jest.fn();
    jest.spyOn(service as any, "getClientAndBucket").mockReturnValue({
      bucket: "bucket-1",
      client: { send: sendMock },
    });
    getSignedUrlMock.mockRejectedValue(new Error("boom"));

    await expect(service.createSignedDownloadUrl("jobs/file.txt")).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  describe("URL prefirmada con dirección pública (solo desarrollo local)", () => {
    const config = (extra: Record<string, string> = {}) => {
      const valores: Record<string, string> = {
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_S3_ENDPOINT: "http://localstack:4566",
        AWS_S3_FORCE_PATH_STYLE: "true",
        S3_BUCKET: "bucket-1",
        ...extra,
      };
      configServiceMock.get.mockImplementation((k: string) => valores[k]);
    };
    const hostDelClienteQueFirmo = async () => {
      const cliente = getSignedUrlMock.mock.calls[0][0];
      return (await cliente.config.endpoint()).hostname;
    };

    it("firma con la dirección pública si está definida (el navegador no resuelve `localstack`)", async () => {
      config({ AWS_S3_PUBLIC_ENDPOINT: "http://localhost:4566" });
      getSignedUrlMock.mockResolvedValue("http://localhost:4566/bucket-1/k?firma");
      await service.createSignedDownloadUrl("results/s1/rubrica.docx");
      expect(await hostDelClienteQueFirmo()).toBe("localhost");
    });

    it("sin dirección pública firma con el endpoint de siempre (producción no cambia)", async () => {
      config();
      getSignedUrlMock.mockResolvedValue("https://s3/bucket-1/k?firma");
      await service.createSignedDownloadUrl("results/s1/rubrica.docx");
      expect(await hostDelClienteQueFirmo()).toBe("localstack");
    });

    it("subir sigue usando el endpoint interno aunque haya dirección pública", async () => {
      config({ AWS_S3_PUBLIC_ENDPOINT: "http://localhost:4566" });
      const enviar = jest.fn().mockResolvedValue(undefined);
      const clienteInterno = (service as any).getClientAndBucket().client;
      jest.spyOn(clienteInterno, "send").mockImplementation(enviar);
      await service.uploadObject({ key: "jobs/x", body: "p", contentType: "text/plain" });
      expect((await clienteInterno.config.endpoint()).hostname).toBe("localstack");
    });
  });
});
