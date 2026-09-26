import type {
  AnswerMap,
  AnswerValue,
  FieldDefinition,
  ClosedChoiceFieldDefinition,
  DynamicSelectFieldDefinition,
} from "../entities/run-form";
import { InvalidFormAnswersError } from "../exceptions/errors";

export function validateAnswers(fields: readonly FieldDefinition[], answers: AnswerMap): void {
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    throw new InvalidFormAnswersError("Answers must be a JSON object");
  }
  for (const field of fields) {
    const value = answers[field.key];
    if (value === undefined) {
      throw new InvalidFormAnswersError(`Missing answer for field "${field.key}"`);
    }
    validateAnswerValue(field, value);
  }
}

function validateAnswerValue(field: FieldDefinition, value: AnswerValue): void {
  if (field.inputType === "checkbox") {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new InvalidFormAnswersError(`Field "${field.key}" must be a string array`);
    }
    validateCheckboxOptions(field, value);
    return;
  }
  if (typeof value !== "string") {
    throw new InvalidFormAnswersError(`Field "${field.key}" must be a string`);
  }
  if (field.inputType === "select") {
    if (isDynamicSelect(field)) {
      validateDynamicSelectValue(field, value);
    } else {
      validateSelectValue(field, value);
    }
  }
}

function validateCheckboxOptions(
  field: ClosedChoiceFieldDefinition,
  value: string[],
): void {
  const known = new Set(field.options);
  const others = value.filter((entry) => !known.has(entry));
  if (others.length === 0) {
    return;
  }
  if (!field.allowOther) {
    throw new InvalidFormAnswersError(
      `Field "${field.key}" contains value(s) not among the declared options and allowOther is false`,
    );
  }
  if (others.length > 1) {
    throw new InvalidFormAnswersError(
      `Field "${field.key}" may contain at most one free-text "Other" value`,
    );
  }
}

function validateSelectValue(
  field: ClosedChoiceFieldDefinition,
  value: string,
): void {
  if (field.options.includes(value)) {
    return;
  }
  if (!field.allowOther) {
    throw new InvalidFormAnswersError(
      `Field "${field.key}" value is not among the declared options and allowOther is false`,
    );
  }
}

function isDynamicSelect(field: FieldDefinition): field is DynamicSelectFieldDefinition {
  return field.inputType === "select" && "dynamic" in field && field.dynamic === true;
}

function validateDynamicSelectValue(
  field: DynamicSelectFieldDefinition,
  value: string,
): void {
  if (value.length === 0) {
    throw new InvalidFormAnswersError(`Field "${field.key}" must be a non-empty string`);
  }
}
