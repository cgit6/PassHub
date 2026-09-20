export interface HumanAccountReaderPort {
  findByUsername(username: string): Promise<unknown | null>;
  findCurrentById(userId: string): Promise<unknown | null>;
}

export interface HumanPasswordDeriverPort {
  derive(password: string, salt: Uint8Array): Promise<Uint8Array>;
}
