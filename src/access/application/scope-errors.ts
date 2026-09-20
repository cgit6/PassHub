export class AccessScopeError extends Error {
  public constructor(
    public readonly code:
      | 'SCOPE_CLOSED'
      | 'INVALID_HANDLE'
      | 'HANDLE_SCOPE_MISMATCH'
      | 'HANDLE_RESOLUTION_MISMATCH'
      | 'SOURCE_FACTS_REQUIRED'
      | 'INVALID_MANAGEMENT_PLAN'
      | 'INVALID_RECOGNITION_PLAN'
      | 'PLAN_HANDLE_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'AccessScopeError';
  }
}
