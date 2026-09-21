export interface SourceCredentialRecordReaderPort {
  findByAlias(alias: 'entry' | 'exit'): Promise<unknown | null>;
}
