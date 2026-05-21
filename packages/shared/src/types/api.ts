export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
