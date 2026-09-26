import { Context } from "../../../../../domain/entities/context";
import type { ContextSecrets } from "../../../../../domain/context";

export class ContextV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly name: string,
    public readonly payload: string,
    public readonly secrets: string,
  ) {}

  public toDomain(): Context {
    return new Context(this.name, JSON.parse(this.payload), this.parseSecrets());
  }

  public static fromDomain(context: Context): ContextV1 {
    return new ContextV1(context.name, JSON.stringify(context.payload), JSON.stringify(context.secrets));
  }

  private parseSecrets(): ContextSecrets {
    if (this.secrets === "") {
      return {};
    }
    return JSON.parse(this.secrets) as ContextSecrets;
  }
}
