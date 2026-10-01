import {
  SourceAuthError,
  type SourcePrincipal,
} from '../../auth/domain/index.js';
import {
  isSourceAuthCapability,
  type SourceAuthCapability,
} from '../../auth/application/source-auth.js';
import type {
  RecognizeAttempt,
  RecognitionAttemptResult,
} from '../../access/application/use-cases.js';
import { executeRecognitionWithArtifact } from '../../access/application/internal/recognition-execution.js';
import type {
  ComparisonPort,
  RecognitionComparisonInput,
} from '../../access/application/comparison/comparison-port.js';
import { isVerifiedComparisonPort } from '../../access/application/comparison/comparison-port.js';
import {
  assertExternalEventId,
  assertExternalSubjectId,
  assertProvider,
  assertRecognitionQrToken,
} from '../../access/application/comparison/recognition-input.js';
import {
  isComparisonArtifact,
  type ComparisonArtifact,
} from '../../access/ports/comparison-artifact.js';
import type {
  RedactedAccessEventProjection,
} from '../../access/ports/index.js';
import {
  type OperationRegistryCapabilityIssuer,
  type OperationRegistryKey,
  type OperationComparisonArtifact,
} from '../../access/application/internal/operation-registry.js';
import { isOperationRegistryCapabilityIssuer } from '../../access/application/internal/operation-registry.js';
import {
  assertAdmissionWorkHandoffBundle,
  type AdmissionWorkHandoffBundle,
  type AdmissionWorkToken,
} from './admission-work-handoff.js';
import {
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionValidatorPort,
  type AdmissionWorkContext,
  type AdmissionWorkPort,
  type AdmissionRecognitionWriterOutcome,
} from './g07b-admission-handler.js';
import {
  type BusinessHttpStatus,
  type HttpResponsePlan,
  type HttpResponsePlanBundle,
  type SafeHttpResponseCode,
} from './http-response-plan.js';
import {
  assertSourceBoundRecognitionExecutorFactory,
  bindG10bRecognitionExecutorToAdmission,
  createSourceBoundRecognitionExecutorForPrincipal,
  type SourceBoundRecognitionExecutorFactory,
} from './source-bound-recognition.js';
import { assertRecognitionEventInvariant } from './recognition-event-invariants.js';

export interface G08bRecognitionCompositionOptions {
  readonly sourceAuth: SourceAuthCapability;
  readonly comparison: ComparisonPort;
  readonly registryCapabilities: OperationRegistryCapabilityIssuer;
  readonly recognizeAttempt: SourceBoundRecognitionExecutorFactory;
  readonly responsePlans: HttpResponsePlanBundle;
  readonly workHandoff: AdmissionWorkHandoffBundle;
}

export interface G08bRecognitionComposition {
  readonly validator: AdmissionValidatorPort;
  readonly work: Pick<AdmissionWorkPort, 'recognition'>;
}

interface RecognitionPayload {
  readonly principal: SourcePrincipal;
  readonly sourceId: string;
  readonly input: RecognitionComparisonInput;
  readonly externalEventId: string;
  readonly registryKey: OperationRegistryKey;
  readonly comparisonArtifact: ComparisonArtifact;
  readonly registryArtifact: OperationComparisonArtifact;
  readonly executor: RecognizeAttempt;
}

const SOURCE_AUTHORIZATION = /^Source (entry|exit)\.[A-Za-z0-9_-]{43}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OWN_KEYS = Object.freeze(['externalEventId', 'kind'] as const);
const QR_KEYS = Object.freeze(['externalEventId', 'kind', 'token'] as const);
const MATCHED_KEYS = Object.freeze(['externalEventId', 'externalSubjectId', 'kind', 'provider'] as const);
const UNKNOWN_KEYS = Object.freeze(['externalEventId', 'kind'] as const);

export function createG08bRecognitionComposition(
  options: G08bRecognitionCompositionOptions,
): G08bRecognitionComposition {
  assertOptions(options);
  assertAdmissionWorkHandoffBundle(options.workHandoff);

  const sourceAuth = options.sourceAuth;
  const comparison = options.comparison;
  const createComparisonArtifact = comparison.artifact.create.bind(comparison.artifact);
  const matchComparisonArtifact = comparison.matches?.bind(comparison);
  const verifySourceCredential = sourceAuth.verifySourceCredential.bind(sourceAuth);
  const readSourceFacts = sourceAuth.facts.bind(sourceAuth);
  const recognizeExecutorFactory = options.recognizeAttempt;
  const issueWork = options.workHandoff.issuer.issue.bind(options.workHandoff.issuer);
  const issueKey = options.registryCapabilities.issueKey.bind(options.registryCapabilities);
  const issueRegistryArtifact = options.registryCapabilities.issueComparisonArtifact.bind(
    options.registryCapabilities,
  );
  const assertRegistryKey = options.registryCapabilities.assertKey.bind(options.registryCapabilities);
  const issueTechnical = options.responsePlans.technical.issue.bind(options.responsePlans.technical);
  const issueBusiness = options.responsePlans.business.issue.bind(options.responsePlans.business);
  const payloads = new WeakMap<object, RecognitionPayload>();
  const artifactInputs = new WeakMap<object, object>();

  const validator: AdmissionValidatorPort = Object.freeze({
    async validate(input: AdmissionValidationInput): Promise<AdmissionValidationResult> {
      if (input.routeId !== 'RECOGNITION_ATTEMPT'
        || (input.retryMode !== 'NORMAL' && input.retryMode !== 'EXISTING_ONLY')
        || input.parameters.id !== undefined
        || input.accepted.query.length !== 0) {
        return rejected(issueTechnical('INVALID_REQUEST'));
      }

      let principal: SourcePrincipal;
      let sourceId: string;
      try {
        const authorization = input.accepted.headers.authorization;
        if (typeof authorization !== 'string' || !SOURCE_AUTHORIZATION.test(authorization)) {
          throw new SourceAuthError('INVALID_SOURCE_CREDENTIAL');
        }
        principal = await verifySourceCredential(authorization.slice('Source '.length));
      } catch (error: unknown) {
        return rejected(issueTechnical(sourceAuthResponseCode(error)));
      }
      try {
        const facts = readSourceFacts(principal);
        sourceId = facts.sourceId;
        if (!UUID_V4.test(sourceId)) throw new SourceAuthError('SOURCE_AUTH_DEPENDENCY_FAILURE');
      } catch (error: unknown) {
        return rejected(issueTechnical('AUTH_UNAVAILABLE'));
      }

      let parsed: Readonly<{
        readonly input: RecognitionComparisonInput;
        readonly externalEventId: string;
      }>;
      try {
        parsed = parseRecognitionBody(input.accepted.body);
      } catch {
        return rejected(issueTechnical('INVALID_REQUEST'));
      }

      let executor: RecognizeAttempt;
      try {
        executor = createSourceBoundRecognitionExecutorForPrincipal(
          recognizeExecutorFactory,
          sourceAuth,
          principal,
        );
        if (typeof executor !== 'object' || executor === null || typeof executor.execute !== 'function') {
          throw new TypeError('recognition executor is invalid');
        }
      } catch {
        return rejected(issueTechnical('REQUEST_STATUS_UNCONFIRMED'));
      }

      try {
        const comparisonArtifact = createComparisonArtifact(parsed.input);
        if (!isComparisonArtifact(comparisonArtifact) || !Object.isFrozen(comparisonArtifact)) {
          throw new TypeError('comparison artifact is not verified');
        }
        const artifactInput = artifactInputs.get(comparisonArtifact);
        if (artifactInput !== undefined && artifactInput !== parsed.input) {
          throw new TypeError('comparison artifact was reused for another input');
        }
        artifactInputs.set(comparisonArtifact, parsed.input);
        const registryKey = issueKey(sourceId, parsed.externalEventId);
        // The registry issuer owns the opaque registry token; the verified
        // comparison artifact is only its private identity.  This lets the
        // configured registry equality seam perform the timing-safe digest
        // comparison without exposing the artifact to HTTP or callers.
        const registryArtifact = issueRegistryArtifact(comparisonArtifact);
        const workInput = issueWork(input.routeId);
        payloads.set(workInput as object, Object.freeze({
          principal,
          sourceId,
          input: parsed.input,
          externalEventId: parsed.externalEventId,
          registryKey,
          comparisonArtifact,
          registryArtifact,
          executor,
        }));
        return Object.freeze({
          kind: 'RECOGNITION',
          registryKey,
          comparisonArtifact: registryArtifact,
          workInput,
        });
      } catch {
        return rejected(issueTechnical('REQUEST_STATUS_UNCONFIRMED'));
      }
    },
  });

  const work = Object.freeze({
    async recognition(input: AdmissionWorkToken, context: AdmissionWorkContext): Promise<AdmissionRecognitionWriterOutcome> {
      const payload = payloads.get(input as object);
      if (payload === undefined) throw new TypeError('recognition work token is missing or already consumed');
      payloads.delete(input as object);

      try {
        bindG10bRecognitionExecutorToAdmission(payload.executor, context);
        const keyFacts = assertRegistryKey(payload.registryKey);
        if (keyFacts.sourceId !== payload.sourceId || keyFacts.externalEventId !== payload.externalEventId) {
          throw new TypeError('recognition registry key provenance mismatch');
        }
        if (artifactInputs.get(payload.comparisonArtifact) !== payload.input) {
          throw new TypeError('recognition artifact input provenance mismatch');
        }
        if (matchComparisonArtifact === undefined
          || !matchComparisonArtifact(payload.input, payload.comparisonArtifact)) {
          throw new TypeError('recognition artifact does not match its frozen input');
        }
        const result = await executeRecognitionWithArtifact(payload.executor, {
          input: payload.input,
          externalEventId: payload.externalEventId,
          receivedAtMs: context.receivedAtMs,
        }, payload.comparisonArtifact);
        return mapRecognitionResult(result, issueBusiness, issueTechnical, {
          sourceId: payload.sourceId,
          input: payload.input,
          receivedAtMs: context.receivedAtMs,
        });
      } catch (error: unknown) {
        return Object.freeze({
          disposition: 'UNKNOWN_EFFECT',
          response: issueTechnical('PERSISTENCE_UNAVAILABLE'),
        });
      }
    },
  });

  return Object.freeze({ validator, work });
}

function mapRecognitionResult(
  result: RecognitionAttemptResult,
  issueBusiness: (status: BusinessHttpStatus, payload: Readonly<Record<string, unknown>>) => HttpResponsePlan,
  issueTechnical: (code: SafeHttpResponseCode) => HttpResponsePlan,
  expected: Parameters<typeof assertRecognitionEventInvariant>[1],
): AdmissionRecognitionWriterOutcome {
  if (result.status === 'COMMITTED' || result.status === 'REPLAYED') {
    const replayed = result.status === 'REPLAYED';
    if ((result.status === 'COMMITTED' && result.replayed !== false)
      || (result.status === 'REPLAYED' && result.replayed !== true)) {
      throw new TypeError('committed recognition result has invalid replay state');
    }
    return Object.freeze({
      disposition: 'BUSINESS_RESULT_PERSISTED',
      originalResponse: issueBusiness(200, eventPayload(result.event, replayed, expected)),
      replayResponse: issueBusiness(200, eventPayload(result.event, true, expected)),
    });
  }
  if (result.status === 'CONFLICT' && result.error.kind === 'IDEMPOTENCY_CONFLICT') {
    return Object.freeze({
      disposition: 'KNOWN_NO_EFFECT',
      response: issueBusiness(409, Object.freeze({ code: 'IDEMPOTENCY_CONFLICT' })),
    });
  }
  return Object.freeze({
    disposition: 'UNKNOWN_EFFECT',
    response: issueTechnical('PERSISTENCE_UNAVAILABLE'),
  });
}

function eventPayload(
  event: RedactedAccessEventProjection,
  replayed: boolean,
  expected: Parameters<typeof assertRecognitionEventInvariant>[1],
): Readonly<Record<string, unknown>> {
  assertEventProjection(event);
  assertRecognitionEventInvariant(event, expected);
  const receivedAt = iso(event.receivedAtMs);
  const recordedAt = iso(event.recordedAtMs);
  if (event.qualificationId !== null && !UUID_V4.test(event.qualificationId)) {
    throw new TypeError('event qualification identity is invalid');
  }
  return Object.freeze({
    eventId: event.eventId,
    sourceId: event.sourceId,
    direction: event.direction,
    kind: event.kind,
    outcome: event.outcome,
    reasonCode: event.reasonCode,
    receivedAt,
    recordedAt,
    qualificationId: event.qualificationId,
    presenceTransition: event.presenceTransition,
    replayed,
  });
}

function assertEventProjection(value: unknown): asserts value is RedactedAccessEventProjection {
  if (!isPlainRecord(value)) throw new TypeError('event projection is invalid');
  exactKeys(value, [
    'direction', 'eventId', 'kind', 'outcome', 'presenceTransition',
    'qualificationId', 'reasonCode', 'recordedAtMs', 'receivedAtMs', 'sourceId',
  ]);
  if (typeof value.eventId !== 'string' || !UUID_V4.test(value.eventId)
    || typeof value.sourceId !== 'string' || !UUID_V4.test(value.sourceId)
    || (value.direction !== 'ENTRY' && value.direction !== 'EXIT')
    || (value.kind !== 'QR_SCANNED' && value.kind !== 'FACE_MATCHED' && value.kind !== 'FACE_UNKNOWN')
    || (value.outcome !== 'ACCEPTED' && value.outcome !== 'REJECTED')
    || !isReasonCode(value.reasonCode)
    || (value.qualificationId !== null
      && (typeof value.qualificationId !== 'string' || !UUID_V4.test(value.qualificationId)))) {
    throw new TypeError('event projection contains invalid facts');
  }
  if (value.presenceTransition !== null) {
    if (!isPlainRecord(value.presenceTransition)) throw new TypeError('event transition is invalid');
    exactKeys(value.presenceTransition, ['from', 'to']);
    if (!isPresence(value.presenceTransition.from) || !isPresence(value.presenceTransition.to)) {
      throw new TypeError('event transition contains invalid presence');
    }
  }
}

function isReasonCode(value: unknown): boolean {
  return value === 'SOURCE_INACTIVE'
    || value === 'INVALID_QR_CREDENTIAL'
    || value === 'FACE_UNKNOWN'
    || value === 'FACE_SUBJECT_NOT_MAPPED'
    || value === 'QUALIFICATION_REVOKED'
    || value === 'ALREADY_INSIDE'
    || value === 'QUALIFICATION_ALREADY_USED'
    || value === 'QUALIFICATION_NOT_YET_VALID'
    || value === 'QUALIFICATION_EXPIRED'
    || value === 'ENTRY_GRANTED'
    || value === 'NOT_INSIDE'
    || value === 'ALREADY_EXITED'
    || value === 'EXIT_RECORDED';
}

function isPresence(value: unknown): boolean {
  return value === 'NOT_ENTERED' || value === 'INSIDE' || value === 'EXITED';
}

function parseRecognitionBody(value: unknown): Readonly<{
  readonly input: RecognitionComparisonInput;
  readonly externalEventId: string;
}> {
  if (!isPlainRecord(value)) throw new TypeError('recognition body must be an object');
  const externalEventId = value.externalEventId;
  if (typeof externalEventId !== 'string') throw new TypeError('external event ID is required');
  assertExternalEventId(externalEventId);
  const kind = value.kind;
  if (kind === 'QR_SCANNED') {
    exactKeys(value, QR_KEYS);
    const token = value.token;
    if (typeof token !== 'string') throw new TypeError('QR token is required');
    assertRecognitionQrToken(token);
    return Object.freeze({
      externalEventId,
      input: Object.freeze({ kind: 'QR_SCANNED', token }),
    });
  }
  if (kind === 'FACE_MATCHED') {
    exactKeys(value, MATCHED_KEYS);
    const provider = value.provider;
    const externalSubjectId = value.externalSubjectId;
    if (typeof provider !== 'string' || typeof externalSubjectId !== 'string') {
      throw new TypeError('matched face fields are required');
    }
    assertProvider(provider);
    assertExternalSubjectId(externalSubjectId);
    return Object.freeze({
      externalEventId,
      input: Object.freeze({ kind: 'FACE_MATCHED', provider, externalSubjectId }),
    });
  }
  if (kind === 'FACE_UNKNOWN') {
    exactKeys(value, UNKNOWN_KEYS);
    return Object.freeze({
      externalEventId,
      input: Object.freeze({ kind: 'FACE_UNKNOWN' }),
    });
  }
  // Keeps the accepted key set explicit for malformed/wrong combinations.
  exactKeys(value, OWN_KEYS);
  throw new TypeError('recognition kind is invalid');
}

function sourceAuthResponseCode(error: unknown): 'AUTHENTICATION_FAILED' | 'AUTH_UNAVAILABLE' {
  return error instanceof SourceAuthError && error.code === 'INVALID_SOURCE_CREDENTIAL'
    ? 'AUTHENTICATION_FAILED'
    : 'AUTH_UNAVAILABLE';
}

function iso(value: number): string {
  if (!Number.isSafeInteger(value)) throw new TypeError('event timestamp is invalid');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('event timestamp is invalid');
  return date.toISOString();
}

function rejected(response: HttpResponsePlan): AdmissionValidationResult {
  return Object.freeze({ kind: 'REJECTED', response });
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError('recognition DTO keys are invalid');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOptions(options: G08bRecognitionCompositionOptions): void {
  if (typeof options !== 'object' || options === null
    || !isSourceAuthCapability(options.sourceAuth)
    || !isVerifiedComparisonPort(options.comparison)
    || typeof options.comparison.matches !== 'function'
    || !isOperationRegistryCapabilityIssuer(options.registryCapabilities)
    || typeof options.registryCapabilities.issueKey !== 'function'
    || typeof options.registryCapabilities.assertKey !== 'function'
    || typeof options.registryCapabilities.issueComparisonArtifact !== 'function'
    || typeof options.recognizeAttempt !== 'object' || options.recognizeAttempt === null
    || typeof options.responsePlans !== 'object' || options.responsePlans === null
    || typeof options.responsePlans.business?.issue !== 'function'
    || typeof options.responsePlans.technical?.issue !== 'function'
    || typeof options.workHandoff !== 'object' || options.workHandoff === null) {
    throw new TypeError('invalid G08b recognition composition options');
  }
  assertSourceBoundRecognitionExecutorFactory(options.recognizeAttempt);
}
