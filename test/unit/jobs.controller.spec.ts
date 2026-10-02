import { BadRequestException } from "@nestjs/common";
import { JobsController } from "../../src/jobs/jobs.controller";
import { JobsService } from "../../src/jobs/jobs.service";

jest.mock("jose", () => ({
  createRemoteJWKSet: jest.fn(() => "jwks"),
  jwtVerify: jest.fn(),
}));

describe("JobsController", () => {
  const jobsServiceMock = {
    createUploadJob: jest.fn(),
    findJobsByUser: jest.fn(),
    getHistoryByUser: jest.fn(),
    getActiveSession: jest.fn(),
    findJobStatus: jest.fn(),
    getDownloadUrl: jest.fn(),
  };

  let controller: JobsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new JobsController(jobsServiceMock as unknown as JobsService);
  });

  it("lists jobs for the authenticated user", async () => {
    jobsServiceMock.findJobsByUser.mockResolvedValue({
      items: [],
      page: 1,
      limit: 10,
      total: 0,
    });

    await expect(
      controller.findAll({ user: { id: "user-1" } } as never, { page: 1, limit: 10 }),
    ).resolves.toEqual({ items: [], page: 1, limit: 10, total: 0 });

    expect(jobsServiceMock.findJobsByUser).toHaveBeenCalledWith("user-1", {
      page: 1,
      limit: 10,
    });
  });

  it("returns history for the authenticated user", async () => {
    jobsServiceMock.getHistoryByUser.mockResolvedValue([]);

    await expect(
      controller.getHistory({ user: { id: "user-1" } } as never),
    ).resolves.toEqual([]);

    expect(jobsServiceMock.getHistoryByUser).toHaveBeenCalledWith("user-1");
  });

  it("rejects missing user on findAll", async () => {
    await expect(controller.findAll({} as never, { page: 1 } as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects missing user on download", async () => {
    await expect(controller.download({} as never, "job-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("devuelve el flujo activo del usuario autenticado", async () => {
    jobsServiceMock.getActiveSession.mockResolvedValue({ active: null });
    await expect(controller.getActive({ user: { id: "user-1" } } as never)).resolves.toEqual({ active: null });
    expect(jobsServiceMock.getActiveSession).toHaveBeenCalledWith("user-1");
  });

  it("rechaza si no hay usuario autenticado", async () => {
    await expect(controller.getActive({ user: undefined } as never)).rejects.toThrow("Authenticated user is required.");
  });

  it("declara la ruta `active` antes de `:id` (si no, `active` se leería como un id)", () => {
    const metodos = Object.getOwnPropertyNames(JobsController.prototype);
    expect(metodos.indexOf("getActive")).toBeGreaterThan(-1);
    expect(metodos.indexOf("getActive")).toBeLessThan(metodos.indexOf("findOne"));
  });
});
