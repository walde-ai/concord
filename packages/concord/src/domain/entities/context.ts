import type { ContextSecrets } from "../context";

export class Context {
  public constructor(
    public readonly name: string,
    public readonly payload: unknown,
    public readonly secrets: Readonly<ContextSecrets>,
  ) {}
}
