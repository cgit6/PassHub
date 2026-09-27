import { types as utilTypes } from 'node:util';

declare const unknownRecognitionRecoveryBrand: unique symbol;

export interface UnknownRecognitionRecoveryToken {
  readonly [unknownRecognitionRecoveryBrand]: never;
}

interface RecoveryIdentity {
  readonly sourceId: string;
  readonly externalEventId: string;
  readonly comparisonArtifact: object;
}

const recoveryIdentities = new WeakMap<object, RecoveryIdentity>();
const EXTERNAL_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function issueUnknownRecognitionRecoveryToken(input: Readonly<{
  readonly sourceId: string;
  readonly externalEventId: string;
  readonly comparisonArtifact: object;
}>): UnknownRecognitionRecoveryToken {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || utilTypes.isProxy(input) ||
      typeof input.sourceId !== 'string' || input.sourceId.length === 0 ||
      typeof input.externalEventId !== 'string' || !EXTERNAL_EVENT_ID.test(input.externalEventId) ||
      typeof input.comparisonArtifact !== 'object' || input.comparisonArtifact === null ||
      utilTypes.isProxy(input.comparisonArtifact) || !Object.isFrozen(input.comparisonArtifact) ||
      Reflect.ownKeys(input.comparisonArtifact).length !== 0) {
    throw new TypeError('unknown recognition recovery identity is invalid');
  }
  const token = Object.freeze({}) as UnknownRecognitionRecoveryToken;
  recoveryIdentities.set(token, Object.freeze({
    sourceId: input.sourceId,
    externalEventId: input.externalEventId,
    comparisonArtifact: input.comparisonArtifact,
  }));
  return token;
}

export function assertUnknownRecognitionRecoveryToken(
  token: UnknownRecognitionRecoveryToken,
): void {
  if ((typeof token !== 'object' && typeof token !== 'function') || token === null ||
      utilTypes.isProxy(token) || !Object.isFrozen(token) || Reflect.ownKeys(token).length !== 0 ||
      recoveryIdentities.get(token) === undefined) {
    throw new TypeError('unknown recognition recovery token is foreign or forged');
  }
}
