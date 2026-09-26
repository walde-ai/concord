import type { Result } from "../../result";
import type { ContextResolveError } from "../../exceptions/errors";
import type { ContextSecrets } from "../../context";

export interface ContextRequester {
  readonly kind: "producer" | "consumer";
  readonly id: string;
}

export type ContextGuard<T> = (value: unknown) => value is T;

export interface ResolvedContext<T> {
  readonly context: T;
  readonly secrets: ContextSecrets;
}

export interface ContextResolver {
  resolve<T>(
    requester: ContextRequester,
    name: string,
    guard: ContextGuard<T>,
  ): Promise<Result<ResolvedContext<T>, ContextResolveError>>;
}
