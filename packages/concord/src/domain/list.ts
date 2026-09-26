export interface ListQuery {
  readonly limit: number;
  readonly offset: number;
}

export interface ListResult<T> {
  readonly items: T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}
