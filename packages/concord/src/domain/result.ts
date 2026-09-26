export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function success<T, E>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function failure<T, E>(error: E): Result<T, E> {
  return { ok: false, error };
}
