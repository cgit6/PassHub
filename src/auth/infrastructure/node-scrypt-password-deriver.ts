import { scrypt } from 'node:crypto';

import type { HumanPasswordDeriverPort } from '../ports/index.js';

const SCRYPT_OPTIONS = Object.freeze({
  N: 131072,
  r: 8,
  p: 1,
  maxmem: 268435456,
});

export class NodeScryptPasswordDeriver implements HumanPasswordDeriverPort {
  public derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
    const saltCopy = Buffer.from(salt);
    return new Promise((resolve, reject) => {
      scrypt(password, saltCopy, 64, SCRYPT_OPTIONS, (error, derivedKey) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(Buffer.from(derivedKey));
      });
    });
  }
}
