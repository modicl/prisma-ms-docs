import { ConfigService } from "@nestjs/config";
import { ConditionalCheckFailedException, DeleteItemCommand, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { DynamoService } from "./dynamo.service";

describe("DynamoService — un solo flujo activo por docente", () => {
  const send = jest.fn();
  let service: DynamoService;

  beforeEach(() => {
    jest.clearAllMocks();
    const config = { get: (k: string) => (k === "DYNAMO_TABLE" ? "chat_sessions" : undefined) };
    service = new DynamoService(config as unknown as ConfigService);
    (service as unknown as { client: unknown }).client = { send };
  });

  const condicional = () => new ConditionalCheckFailedException({ message: "x", $metadata: {} });

  it("reserva el cupo con una escritura condicional sobre el registro user#<id>", async () => {
    send.mockResolvedValueOnce({});
    await expect(service.acquireUserSlot("u1", "s1", 600)).resolves.toEqual({ acquired: true });
    const cmd = send.mock.calls[0][0] as PutItemCommand;
    expect(cmd).toBeInstanceOf(PutItemCommand);
    expect(cmd.input.Item?.session_id).toEqual({ S: "user#u1" });
    expect(cmd.input.Item?.active_session).toEqual({ S: "s1" });
    expect(cmd.input.ConditionExpression).toContain("attribute_not_exists(session_id)");
    expect(cmd.input.ConditionExpression).toContain("active_until < :now");
  });

  it("si el cupo está ocupado devuelve la sesión activa", async () => {
    send.mockRejectedValueOnce(condicional());
    send.mockResolvedValueOnce({ Item: { active_session: { S: "otra" } } });
    await expect(service.acquireUserSlot("u1", "s2")).resolves.toEqual({ acquired: false, activeSessionId: "otra" });
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetItemCommand);
  });

  it("propaga los demás errores de DynamoDB", async () => {
    send.mockRejectedValueOnce(new Error("boom"));
    await expect(service.acquireUserSlot("u1", "s1")).rejects.toThrow();
  });

  it("libera solo si el cupo es de esa sesión y no falla si era de otra", async () => {
    send.mockRejectedValueOnce(condicional());
    await expect(service.releaseUserSlot("u1", "s1")).resolves.toBeUndefined();
    const cmd = send.mock.calls[0][0] as DeleteItemCommand;
    expect(cmd).toBeInstanceOf(DeleteItemCommand);
    expect(cmd.input.ConditionExpression).toContain("active_session = :sid");
  });

  describe("getActiveSession (solo lectura)", () => {
    const ahora = () => Math.floor(Date.now() / 1000);
    const cupo = (sesion: string, hasta: number) => ({ Item: { active_session: { S: sesion }, active_until: { N: String(hasta) } } });

    it("devuelve la sesión activa del docente leyendo su cupo y la sesión", async () => {
      send.mockResolvedValueOnce(cupo("s1", ahora() + 300));
      send.mockResolvedValueOnce({ Item: { phase: { S: "awaiting_hitl" }, workflow_status: { S: "" } } });
      await expect(service.getActiveSession("u1")).resolves.toEqual({ sessionId: "s1", phase: "awaiting_hitl", workflowStatus: null });
      const [primera, segunda] = send.mock.calls.map((c) => c[0] as GetItemCommand);
      expect(primera).toBeInstanceOf(GetItemCommand);
      expect(primera.input.Key).toEqual({ session_id: { S: "user#u1" } });
      expect(segunda.input.Key).toEqual({ session_id: { S: "s1" } });
    });

    it("es solo lectura: no escribe ni borra nada", async () => {
      send.mockResolvedValueOnce(cupo("s1", ahora() - 5));
      await service.getActiveSession("u1");
      for (const [cmd] of send.mock.calls) {
        expect(cmd).toBeInstanceOf(GetItemCommand);
      }
    });

    it("null si el docente no tiene cupo", async () => {
      send.mockResolvedValueOnce({});
      await expect(service.getActiveSession("u1")).resolves.toBeNull();
    });

    it("null si el cupo ya venció", async () => {
      send.mockResolvedValueOnce(cupo("s1", ahora() - 1));
      await expect(service.getActiveSession("u1")).resolves.toBeNull();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("null si la sesión del cupo ya no existe", async () => {
      send.mockResolvedValueOnce(cupo("s1", ahora() + 300));
      send.mockResolvedValueOnce({});
      await expect(service.getActiveSession("u1")).resolves.toBeNull();
    });

    it.each(["completed", "error"])("null si la sesión ya terminó (%s)", async (fase) => {
      send.mockResolvedValueOnce(cupo("s1", ahora() + 300));
      send.mockResolvedValueOnce({ Item: { phase: { S: fase } } });
      await expect(service.getActiveSession("u1")).resolves.toBeNull();
    });
  });
});
