export const RECOGNITION_QR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
export const PROVIDER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
export const EXTERNAL_EVENT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type RecognitionComparisonInput =
  | Readonly<{ kind: 'QR_SCANNED'; token: string }>
  | Readonly<{
      kind: 'FACE_MATCHED';
      provider: string;
      externalSubjectId: string;
    }>
  | Readonly<{ kind: 'FACE_UNKNOWN' }>;

export type ComparisonInputErrorCode =
  | 'INVALID_RECOGNITION_KIND'
  | 'INVALID_QR_TOKEN'
  | 'INVALID_PROVIDER'
  | 'INVALID_EXTERNAL_EVENT_ID'
  | 'INVALID_EXTERNAL_SUBJECT_ID';

export class ComparisonInputError extends Error {
  public constructor(
    public readonly code: ComparisonInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ComparisonInputError';
  }
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertString(
  value: unknown,
  code: ComparisonInputErrorCode,
  label: string,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new ComparisonInputError(code, `${label} must be a string`);
  }
}

export function assertRecognitionQrToken(token: string): void {
  assertString(token, 'INVALID_QR_TOKEN', 'QR token');
  if (!RECOGNITION_QR_PATTERN.test(token)) {
    throw new ComparisonInputError(
      'INVALID_QR_TOKEN',
      'QR token must be 1-128 base64url alphabet characters',
    );
  }
}

export function assertProvider(provider: string): void {
  assertString(provider, 'INVALID_PROVIDER', 'provider');
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new ComparisonInputError(
      'INVALID_PROVIDER',
      'provider does not match the fixed provider grammar',
    );
  }
}

export function assertExternalEventId(externalEventId: string): void {
  assertString(
    externalEventId,
    'INVALID_EXTERNAL_EVENT_ID',
    'external event ID',
  );
  if (!EXTERNAL_EVENT_ID_PATTERN.test(externalEventId)) {
    throw new ComparisonInputError(
      'INVALID_EXTERNAL_EVENT_ID',
      'external event ID does not match the fixed event ID grammar',
    );
  }
}

export function assertExternalSubjectId(externalSubjectId: string): void {
  assertString(
    externalSubjectId,
    'INVALID_EXTERNAL_SUBJECT_ID',
    'external subject ID',
  );
  if (
    externalSubjectId.length === 0 ||
    containsUnpairedSurrogate(externalSubjectId) ||
    Buffer.byteLength(externalSubjectId, 'utf8') > 256 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(externalSubjectId)
  ) {
    throw new ComparisonInputError(
      'INVALID_EXTERNAL_SUBJECT_ID',
      'external subject ID violates its Unicode or UTF-8 byte contract',
    );
  }
}

export function assertRecognitionComparisonInput(
  input: RecognitionComparisonInput,
): void {
  if (typeof input !== 'object' || input === null) {
    throw new ComparisonInputError(
      'INVALID_RECOGNITION_KIND',
      'recognition input must be an object',
    );
  }
  switch (input.kind) {
    case 'QR_SCANNED':
      assertRecognitionQrToken(input.token);
      return;
    case 'FACE_MATCHED':
      assertProvider(input.provider);
      assertExternalSubjectId(input.externalSubjectId);
      return;
    case 'FACE_UNKNOWN':
      return;
    default:
      throw new ComparisonInputError(
        'INVALID_RECOGNITION_KIND',
        'recognition input kind is unknown',
      );
  }
}
