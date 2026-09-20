import { createHash, randomBytes } from 'node:crypto';

import { assertRecognitionQrToken } from './recognition-input.js';

const QR_LOOKUP_DOMAIN = Buffer.from('PassHub/qr-lookup/v1\0', 'utf8');

export function issueQrToken(): string {
  return randomBytes(32).toString('base64url');
}

export function computeQrLookupDigest(token: string): string {
  assertRecognitionQrToken(token);
  return createHash('sha256')
    .update(QR_LOOKUP_DOMAIN)
    .update(Buffer.from(token, 'utf8'))
    .digest('hex');
}
