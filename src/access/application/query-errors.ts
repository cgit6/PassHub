export type QueryApplicationErrorCode =
  | 'INVALID_REQUEST'
  | 'RESOURCE_NOT_FOUND'
  | 'PERSISTENCE_UNAVAILABLE'
  | 'TECHNICAL_BUSY'
  | 'DATASET_EPOCH_MISMATCH'
  | 'CURSOR_SCOPE_MISMATCH'
  | 'INVALID_CURSOR';

const applicationErrors = new WeakSet<object>();

export class QueryApplicationError extends Error {
  public constructor(public readonly code: QueryApplicationErrorCode) {
    super(code);
    this.name = 'QueryApplicationError';
    applicationErrors.add(this);
  }
}

export function isQueryApplicationError(value: unknown): value is QueryApplicationError {
  return typeof value === 'object' && value !== null && applicationErrors.has(value);
}
