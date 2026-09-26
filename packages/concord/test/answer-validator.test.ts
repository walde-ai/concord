import { describe, it, expect } from "vitest";
import type { FieldDefinition } from "../src/domain/entities/run-form";
import { validateAnswers } from "../src/domain/interactors/answer-validator";
import { InvalidFormAnswersError } from "../src/domain/exceptions/errors";

const checkboxField: FieldDefinition = {
  key: "choices",
  label: "Choices",
  inputType: "checkbox",
  options: ["A", "B"],
  allowOther: false,
  defaultValue: [],
};

const selectField: FieldDefinition = {
  key: "plan",
  label: "Plan",
  inputType: "select",
  options: ["A", "B"],
  allowOther: false,
  defaultValue: "A",
};

const selectWithOtherField: FieldDefinition = {
  key: "plan",
  label: "Plan",
  inputType: "select",
  options: ["A", "B"],
  allowOther: true,
  defaultValue: "A",
};

const checkboxWithOtherField: FieldDefinition = {
  key: "choices",
  label: "Choices",
  inputType: "checkbox",
  options: ["A", "B"],
  allowOther: true,
  defaultValue: [],
};

const textField: FieldDefinition = {
  key: "note",
  label: "Note",
  inputType: "text",
  defaultValue: "",
};

const dynamicSelectField: FieldDefinition = {
  key: "spec",
  label: "Spec",
  inputType: "select",
  dynamic: true,
  dependsOn: "repo",
  allowOther: false,
  defaultValue: "",
};

describe("validateAnswers", () => {
  it("accepts an answers map that satisfies every field", () => {
    expect(() =>
      validateAnswers([checkboxField, selectField, textField], {
        choices: ["A"],
        plan: "B",
        note: "ok",
      }),
    ).not.toThrow();
  });

  it("rejects a missing field key", () => {
    expect(() =>
      validateAnswers([checkboxField, selectField, textField], {
        choices: ["A"],
        plan: "B",
      }),
    ).toThrow(InvalidFormAnswersError);
  });

  it("rejects a string value for a checkbox field", () => {
    expect(() =>
      validateAnswers([checkboxField], { choices: "A" }),
    ).toThrow(InvalidFormAnswersError);
  });

  it("rejects an array value for a select field", () => {
    expect(() =>
      validateAnswers([selectField], { plan: ["A"] }),
    ).toThrow(InvalidFormAnswersError);
  });

  it("rejects a select value not among options when allowOther is false", () => {
    expect(() =>
      validateAnswers([selectField], { plan: "C" }),
    ).toThrow(InvalidFormAnswersError);
  });

  it("accepts a select value not among options when allowOther is true", () => {
    expect(() =>
      validateAnswers([selectWithOtherField], { plan: "C" }),
    ).not.toThrow();
  });

  it("rejects more than one free-text Other entry on a checkbox field", () => {
    expect(() =>
      validateAnswers([checkboxWithOtherField], { choices: ["A", "X", "Y"] }),
    ).toThrow(InvalidFormAnswersError);
  });

  it("accepts a single free-text Other entry on a checkbox field with allowOther", () => {
    expect(() =>
      validateAnswers([checkboxWithOtherField], { choices: ["A", "X"] }),
    ).not.toThrow();
  });

  it("accepts any non-empty string for a dynamic select field", () => {
    expect(() =>
      validateAnswers([dynamicSelectField], { spec: "https://github.com/owner/repo/issues/123" }),
    ).not.toThrow();
  });

  it("rejects an empty string for a dynamic select field", () => {
    expect(() =>
      validateAnswers([dynamicSelectField], { spec: "" }),
    ).toThrow(InvalidFormAnswersError);
  });

  it("rejects a non-string value for a dynamic select field", () => {
    expect(() =>
      validateAnswers([dynamicSelectField], { spec: ["value"] }),
    ).toThrow(InvalidFormAnswersError);
  });
});
