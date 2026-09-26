import type { AnswerMap, RunForm } from "../entities/run-form";
import type { SubmitRunInput } from "../ports/in/submit-run-input";
import type { FormRepository } from "../ports/out/form-repository";
import type { RunInputRegistry } from "../ports/out/run-input-registry";
import type { Clock } from "../ports/out/clock";
import {
  FormAlreadyAnsweredError,
  FormNotFoundError,
  RunNotPendingInputError,
} from "../exceptions/errors";
import { validateAnswers } from "./answer-validator";

export class SubmitRunInputInteractor implements SubmitRunInput {
  public constructor(
    private readonly formRepository: FormRepository,
    private readonly inputRegistry: RunInputRegistry,
    private readonly clock: Clock,
  ) {}

  public async submit(runId: string, formId: string, answers: AnswerMap): Promise<RunForm> {
    const form = await this.formRepository.getById(formId);
    if (form.runId !== runId) {
      throw new FormNotFoundError(formId);
    }
    if (form.status === "ANSWERED") {
      throw new FormAlreadyAnsweredError(formId);
    }
    validateAnswers(form.fields, answers);
    form.markAnswered(answers, this.clock.now());
    await this.formRepository.save(form);

    const handle = this.inputRegistry.lookup(runId);
    if (handle === null) {
      throw new RunNotPendingInputError(runId);
    }
    handle.resolve(answers);
    return form;
  }
}
