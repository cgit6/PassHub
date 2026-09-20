export interface SourceCredentialVerificationContext {
  readonly scopeId: string;
  readonly epoch: string;
  readonly owner: string;
}

/** Authentication-only capability; Access receives facts, never credentials. */
export interface SourceCredentialVerificationPort {
  verify(
    context: SourceCredentialVerificationContext,
    alias: string,
    secret: string,
  ): Promise<Readonly<{
    sourceId: string;
    direction: 'ENTRY' | 'EXIT';
    active: boolean;
  }> | null>;
}
