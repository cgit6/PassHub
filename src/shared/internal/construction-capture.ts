import { types as utilTypes } from 'node:util';

/** Read a trusted construction property once, accepting class prototype data methods. */
export function captureConstructionProperty(value: unknown, key: string, label: string): unknown {
  return capture(value, key, label, false);
}

export function captureOptionalConstructionProperty(value: unknown, key: string, label: string): unknown {
  return capture(value, key, label, true);
}

export function captureConstructionMethod(value: unknown, key: string, _label: string): Function {
  const method = captureConstructionProperty(value, key, _label);
  if (typeof method !== 'function' || isProxySafely(method)) throw genericFailure();
  return method;
}

function capture(value: unknown, key: string, _label: string, optional: boolean): unknown {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || isProxySafely(value)) {
      throw genericFailure();
    }
    let current: object | null = value as object;
    while (current !== null) {
      if (isProxySafely(current)) throw genericFailure();
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        assertPrototypeChain(current);
        if (!Object.hasOwn(descriptor, 'value')) throw genericFailure();
        if ((typeof descriptor.value === 'object' && descriptor.value !== null)
          || typeof descriptor.value === 'function') {
          if (isProxySafely(descriptor.value)) throw genericFailure();
        }
        return descriptor.value;
      }
      current = Object.getPrototypeOf(current);
    }
    if (optional) return undefined;
    throw genericFailure();
  } catch {
    throw genericFailure();
  }
}

function assertPrototypeChain(value: object): void {
  let current = Object.getPrototypeOf(value);
  while (current !== null) {
    if (isProxySafely(current)) throw genericFailure();
    current = Object.getPrototypeOf(current);
  }
}

function isProxySafely(value: object): boolean {
  try { return utilTypes.isProxy(value); } catch { throw genericFailure(); }
}

function genericFailure(): TypeError {
  return new TypeError('invalid construction capability');
}
