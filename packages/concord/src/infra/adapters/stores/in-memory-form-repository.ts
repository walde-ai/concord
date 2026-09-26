import type { FormRepository } from "../../../domain/ports/out/form-repository";
import type { RunForm } from "../../../domain/entities/run-form";
import { FormNotFoundError } from "../../../domain/exceptions/errors";

export class InMemoryFormRepository implements FormRepository {
  private readonly forms: Map<string, RunForm> = new Map();

  public async save(form: RunForm): Promise<void> {
    this.forms.set(form.id, form);
  }

  public async getById(id: string): Promise<RunForm> {
    const form = this.forms.get(id);
    if (form === undefined) {
      throw new FormNotFoundError(id);
    }
    return form;
  }

  public async listByRun(runId: string): Promise<RunForm[]> {
    const matching: RunForm[] = [];
    for (const form of this.forms.values()) {
      if (form.runId === runId) {
        matching.push(form);
      }
    }
    matching.sort((a, b) => a.round - b.round);
    return matching;
  }

  public async countByRun(runId: string): Promise<number> {
    let count = 0;
    for (const form of this.forms.values()) {
      if (form.runId === runId) {
        count += 1;
      }
    }
    return count;
  }

  public async getPendingByRun(runId: string): Promise<RunForm | null> {
    for (const form of this.forms.values()) {
      if (form.runId === runId && form.status === "PENDING") {
        return form;
      }
    }
    return null;
  }
}
