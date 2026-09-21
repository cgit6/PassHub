/** Authentication-only capability; Access receives facts, never credentials. */
export interface SourceCredentialVerificationPort {
  verify(
    alias: string,
    secret: string,
  ): Promise<Readonly<{
    sourceId: string;
  }> | null>;
}
