const PROVIDER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const EXTERNAL_EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function assertProvider(provider: string): void {
  if (typeof provider !== 'string' || !PROVIDER_PATTERN.test(provider)) {
    throw new TypeError('provider does not match the fixed provider grammar');
  }
}

export function assertExternalSubjectId(externalSubjectId: string): void {
  if (typeof externalSubjectId !== 'string' || externalSubjectId.length === 0 ||
      containsUnpairedSurrogate(externalSubjectId) ||
      Buffer.byteLength(externalSubjectId, 'utf8') > 256 ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(externalSubjectId)) {
    throw new TypeError('external subject ID violates its Unicode or UTF-8 byte contract');
  }
}

export function assertExternalEventId(externalEventId: string): void {
  if (typeof externalEventId !== 'string' || !EXTERNAL_EVENT_ID_PATTERN.test(externalEventId)) {
    throw new TypeError('external event ID does not match the fixed event ID grammar');
  }
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}
