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
});
