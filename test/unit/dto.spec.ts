import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ListJobsQueryDto } from "../../src/jobs/dto/list-jobs-query.dto";
import { UploadJobDto } from "../../src/jobs/dto/upload-job.dto";

describe("DTO validation", () => {
  it("uses defaults for list jobs query", async () => {
    const dto = plainToInstance(ListJobsQueryDto, {});

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(10);
  });

  it("rejects invalid list jobs query", async () => {
    const dto = plainToInstance(ListJobsQueryDto, { page: 0, limit: 101 });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects upload job payloads that exceed max lengths", async () => {
    const dto = plainToInstance(UploadJobDto, {
      prompt: "a".repeat(4001),
      paciJson: "b".repeat(200001),
    });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
  });
});
