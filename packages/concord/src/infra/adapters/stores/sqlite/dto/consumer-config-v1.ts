import type { ConsumerConfigSecrets, ConsumerConfigValues } from "../../../../../domain/component";

export class ConsumerConfigV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly consumerId: string,
    public readonly values: ConsumerConfigValues,
    public readonly secrets: ConsumerConfigSecrets,
  ) {}

  public toValuesJson(): string {
    return JSON.stringify(this.values);
  }

  public toSecretsJson(): string {
    return JSON.stringify(this.secrets);
  }

  public static fromRow(consumerId: string, valuesJson: string, secretsJson: string): ConsumerConfigV1 {
    return new ConsumerConfigV1(consumerId, parseValues(valuesJson), parseValues(secretsJson));
  }

  public static fromDomain(
    consumerId: string,
    values: ConsumerConfigValues,
    secrets: ConsumerConfigSecrets,
  ): ConsumerConfigV1 {
    return new ConsumerConfigV1(consumerId, { ...values }, { ...secrets });
  }
}

function parseValues(valuesJson: string): ConsumerConfigValues {
  if (valuesJson.length === 0) {
    return {};
  }
  const parsed = JSON.parse(valuesJson) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as ConsumerConfigValues;
}
