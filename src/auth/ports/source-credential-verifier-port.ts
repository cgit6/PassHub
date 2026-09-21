/** Auth-owned structural view of the narrow Sources authentication capability. */
export interface SourceCredentialVerifierPort {
  verify(alias: string, secret: string): Promise<Readonly<{ sourceId: string }> | null>;
}
