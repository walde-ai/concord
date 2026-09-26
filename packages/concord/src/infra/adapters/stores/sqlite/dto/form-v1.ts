import {
  RunForm,
  type FieldDefinition,
  type AnswerMap,
  type FormStatus,
} from "../../../../../domain/entities/run-form";

interface StoredFieldOption {
  readonly key: string;
  readonly label: string;
  readonly inputType: string;
  readonly options?: readonly string[];
  readonly allowOther?: boolean;
  readonly placeholder?: string;
  readonly dynamic?: boolean;
  readonly dependsOn?: string;
  readonly defaultValue: unknown;
}

interface StoredDefinition {
  readonly prompt: string;
  readonly fields: readonly StoredFieldOption[];
  readonly context?: string;
}

export class FormV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly id: string,
    public readonly runId: string,
    public readonly consumerId: string,
    public readonly round: number,
    public readonly status: FormStatus,
    public readonly definition: string,
    public readonly answers: string | null,
    public readonly createdAt: string,
    public readonly answeredAt: string | null,
  ) {}

  public toDomain(): RunForm {
    const definition = JSON.parse(this.definition) as StoredDefinition;
    const fields = definition.fields.map(toDomainField);
    const answers = this.answers === null ? null : (JSON.parse(this.answers) as AnswerMap);
    return new RunForm(
      this.id,
      this.runId,
      this.consumerId,
      this.round,
      definition.prompt,
      fields,
      this.status,
      answers,
      new Date(this.createdAt),
      this.answeredAt === null ? null : new Date(this.answeredAt),
      typeof definition.context === "string" ? definition.context : "",
    );
  }

  public static fromDomain(form: RunForm): FormV1 {
    const definition: StoredDefinition = {
      prompt: form.prompt,
      fields: form.fields.map(toStoredField),
      ...(form.context.length > 0 ? { context: form.context } : {}),
    };
    return new FormV1(
      form.id,
      form.runId,
      form.consumerId,
      form.round,
      form.status,
      JSON.stringify(definition),
      form.answers === null ? null : JSON.stringify(form.answers),
      form.createdAt.toISOString(),
      form.answeredAt === null ? null : form.answeredAt.toISOString(),
    );
  }
}

function toDomainField(stored: StoredFieldOption): FieldDefinition {
  if (stored.inputType === "text" || stored.inputType === "textarea") {
    const placeholder =
      typeof stored.placeholder === "string" ? { placeholder: stored.placeholder } : {};
    return {
      key: stored.key,
      label: stored.label,
      inputType: stored.inputType,
      defaultValue: typeof stored.defaultValue === "string" ? stored.defaultValue : "",
      ...placeholder,
    };
  }
  if (stored.inputType === "select" && stored.dynamic === true) {
    return {
      key: stored.key,
      label: stored.label,
      inputType: "select",
      dynamic: true,
      dependsOn: typeof stored.dependsOn === "string" ? stored.dependsOn : "",
      allowOther: typeof stored.allowOther === "boolean" ? stored.allowOther : false,
      defaultValue: typeof stored.defaultValue === "string" ? stored.defaultValue : "",
    };
  }
  const options = Array.isArray(stored.options) ? [...stored.options] : [];
  const defaultValue =
    stored.inputType === "checkbox"
      ? Array.isArray(stored.defaultValue)
        ? (stored.defaultValue as string[]).filter((v) => typeof v === "string")
        : []
      : typeof stored.defaultValue === "string"
        ? stored.defaultValue
        : "";
  return {
    key: stored.key,
    label: stored.label,
    inputType: stored.inputType as "checkbox" | "select",
    options,
    allowOther: typeof stored.allowOther === "boolean" ? stored.allowOther : false,
    defaultValue,
  };
}

function toStoredField(field: FieldDefinition): StoredFieldOption {
  if (field.inputType === "select" && "dynamic" in field && field.dynamic === true) {
    return {
      key: field.key,
      label: field.label,
      inputType: field.inputType,
      dynamic: true,
      dependsOn: field.dependsOn,
      allowOther: field.allowOther,
      defaultValue: field.defaultValue,
    };
  }
  return {
    key: field.key,
    label: field.label,
    inputType: field.inputType,
    options: "options" in field ? [...field.options] : undefined,
    allowOther: "allowOther" in field ? field.allowOther : undefined,
    placeholder:
      (field.inputType === "text" || field.inputType === "textarea") && field.placeholder !== undefined
        ? field.placeholder
        : undefined,
    defaultValue: field.defaultValue,
  };
}
