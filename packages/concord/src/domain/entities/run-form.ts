export type FormStatus = "PENDING" | "ANSWERED";

export type FieldInputType = "checkbox" | "select" | "text" | "textarea";

export interface ClosedChoiceFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly inputType: "checkbox" | "select";
  readonly options: readonly string[];
  readonly allowOther: boolean;
  readonly defaultValue: string[] | string;
}

export interface FreeTextFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly inputType: "text" | "textarea";
  readonly defaultValue: string;
  readonly placeholder?: string;
}

export interface DynamicSelectFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly inputType: "select";
  readonly dynamic: true;
  readonly dependsOn: string;
  readonly allowOther: boolean;
  readonly defaultValue: string;
}

export type FieldDefinition = ClosedChoiceFieldDefinition | FreeTextFieldDefinition | DynamicSelectFieldDefinition;

export type AnswerValue = string | string[];

export type AnswerMap = Record<string, AnswerValue>;

export interface FormDefinition {
  readonly prompt: string;
  readonly fields: readonly FieldDefinition[];
  /**
   * Optional Markdown the caller (the agent) supplies as a preamble shown to
   * the user BEFORE the prompt and fields. This is where the agent presents its
   * initial analysis so the user can answer the questions in context. Carried
   * through to the form unchanged.
   */
  readonly context?: string;
}

export class RunForm {
  public status: FormStatus;
  public answers: AnswerMap | null;
  public answeredAt: Date | null;

  public constructor(
    public readonly id: string,
    public readonly runId: string,
    public readonly consumerId: string,
    public readonly round: number,
    public readonly prompt: string,
    public readonly fields: readonly FieldDefinition[],
    status: FormStatus = "PENDING",
    answers: AnswerMap | null = null,
    public readonly createdAt: Date,
    answeredAt: Date | null = null,
    public readonly context: string = "",
  ) {
    this.status = status;
    this.answers = answers;
    this.answeredAt = answeredAt;
  }

  public markAnswered(answers: AnswerMap, now: Date): void {
    if (this.status !== "PENDING") {
      throw new Error(`Form ${this.id} is already answered`);
    }
    this.status = "ANSWERED";
    this.answers = answers;
    this.answeredAt = now;
  }
}
