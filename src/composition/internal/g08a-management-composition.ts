import type { HumanAuthCapability } from '../../auth/application/index.js';
import { HumanAuthError, type HumanPrincipal } from '../../auth/domain/index.js';
import {
  ManagementApplicationError,
} from '../../access/application/management-errors.js';
import type {
  CreateQualificationCommand,
  ManageQualifications,
  RevokeQualificationCommand,
  UpdateQualificationCommand,
} from '../../access/application/index.js';
import {
  G04bTransactionError,
} from '../../infrastructure/mongo/g04b-persistence-adapter.js';
import {
  assertExternalSubjectId,
  assertProvider,
} from '../../access/ports/recognition-validation.js';
import {
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionValidatorPort,
  type AdmissionWorkContext,
  type AdmissionWorkPort,
  type AdmissionWriterOutcome,
} from './g07b-admission-handler.js';
import type {
  AdmissionWorkHandoffBundle,
  AdmissionWorkToken,
} from './admission-work-handoff.js';
import { assertAdmissionWorkHandoffBundle } from './admission-work-handoff.js';
import type {
  HttpResponsePlan,
  HttpResponsePlanBundle,
} from './http-response-plan.js';
import type { BusinessRouteId } from '../../shared/internal/http/index.js';

type ManagementRouteId =
  | 'QUALIFICATION_CREATE'
  | 'QUALIFICATION_UPDATE'
  | 'QUALIFICATION_REVOKE';

interface ManagementPayload {
  readonly routeId: ManagementRouteId;
  readonly principal: HumanPrincipal;
  readonly qualificationId: string | null;
  readonly body: CreateBody | UpdateBody | RevokeBody;
}

interface CreateBody {
  readonly kind: 'CREATE';
  readonly displayName: string;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly face: FaceMappingInput | null;
}

interface UpdateBody {
  readonly kind: 'UPDATE';
  readonly fields: Readonly<{
    readonly displayName?: string;
    readonly validFromMs?: number;
    readonly validUntilMs?: number;
    readonly face?: FaceMappingInput | null;
  }>;
}

interface RevokeBody {
  readonly kind: 'REVOKE';
  readonly reason: string;
}

interface FaceMappingInput {
  readonly provider: string;
  readonly externalSubjectId: string;
}

export interface G08aManagementCompositionOptions {
  readonly auth: HumanAuthCapability;
  readonly manageQualifications: ManageQualifications;
  readonly responsePlans: HttpResponsePlanBundle;
  readonly workHandoff: AdmissionWorkHandoffBundle;
}

export interface G08aManagementComposition {
  readonly validator: AdmissionValidatorPort;
  readonly work: Pick<AdmissionWorkPort, 'management'>;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BEARER = /^Bearer ([^\s]+)$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function createG08aManagementComposition(
  options: G08aManagementCompositionOptions,
): G08aManagementComposition {
  assertOptions(options);
  assertAdmissionWorkHandoffBundle(options.workHandoff);
  const verifyAccessToken = options.auth.verifyAccessToken.bind(options.auth);
  const assertRole = options.auth.assertRole.bind(options.auth);
  const readFacts = options.auth.facts.bind(options.auth);
  const issueWork = options.workHandoff.issuer.issue.bind(options.workHandoff.issuer);
  const createQualification = options.manageQualifications.create.bind(options.manageQualifications);
  const updateQualification = options.manageQualifications.update.bind(options.manageQualifications);
  const revokeQualification = options.manageQualifications.revoke.bind(options.manageQualifications);
  const issueTechnical = options.responsePlans.technical.issue.bind(options.responsePlans.technical);
  const issueBusiness = options.responsePlans.business.issue.bind(options.responsePlans.business);
  const payloads = new WeakMap<object, ManagementPayload>();
  const issueInvalid = (): HttpResponsePlan => issueTechnical('INVALID_REQUEST');

  const validator: AdmissionValidatorPort = Object.freeze({
    async validate(input: AdmissionValidationInput): Promise<AdmissionValidationResult> {
      if (!isManagementRoute(input.routeId) || input.retryMode !== 'NORMAL' || input.parameters.id !== undefined && !UUID_V4.test(input.parameters.id)) {
        return Object.freeze({ kind: 'REJECTED', response: issueInvalid() });
      }
      if (input.accepted.query.length !== 0) {
        return Object.freeze({ kind: 'REJECTED', response: issueInvalid() });
      }
      let principal: HumanPrincipal;
      try {
        const authorization = input.accepted.headers.authorization;
        const match = typeof authorization === 'string' ? BEARER.exec(authorization) : null;
        if (match === null) throw new HumanAuthError('INVALID_TOKEN');
        const accessToken = match[1];
        if (accessToken === undefined) throw new HumanAuthError('INVALID_TOKEN');
        principal = await verifyAccessToken(accessToken);
        assertRole(principal, 'OPERATOR');
      } catch (error: unknown) {
        if (error instanceof HumanAuthError) {
          if (error.code === 'INVALID_TOKEN') {
            return Object.freeze({ kind: 'REJECTED', response: issueTechnical('AUTHENTICATION_FAILED') });
          }
          if (error.code === 'ROLE_FORBIDDEN') {
            return Object.freeze({ kind: 'REJECTED', response: issueTechnical('FORBIDDEN') });
          }
          return Object.freeze({ kind: 'REJECTED', response: issueTechnical('AUTH_UNAVAILABLE') });
        }
        return Object.freeze({ kind: 'REJECTED', response: issueTechnical('AUTH_UNAVAILABLE') });
      }
      let accountId: string;
      try {
        accountId = readFacts(principal).userId;
      } catch (error: unknown) {
        return Object.freeze({ kind: 'REJECTED', response: issueTechnical(
          error instanceof HumanAuthError && error.code === 'INVALID_TOKEN'
            ? 'AUTHENTICATION_FAILED'
            : 'AUTH_UNAVAILABLE',
        ) });
      }
      try {
        const qualificationId = input.routeId === 'QUALIFICATION_CREATE'
          ? null
          : parsePathId(input.parameters.id);
        const body = parseBody(input.routeId, input.accepted.body);
        const token = issueWork(input.routeId);
        payloads.set(token as object, Object.freeze({ routeId: input.routeId, principal, qualificationId, body }));
        return Object.freeze({
          kind: 'MANAGEMENT',
          accountId,
          workInput: token,
        });
      } catch {
        return Object.freeze({ kind: 'REJECTED', response: issueInvalid() });
      }
    },
  });

  const work = Object.freeze({
    async management(input: AdmissionWorkToken, context: AdmissionWorkContext): Promise<AdmissionWriterOutcome> {
      const payload = payloads.get(input as object);
      if (payload === undefined) throw new TypeError('management work token is missing or already consumed');
      payloads.delete(input as object);
      let actorId: string;
      try {
        actorId = readFacts(payload.principal).userId;
      } catch (error: unknown) {
        return Object.freeze({
          disposition: 'UNKNOWN_EFFECT',
          response: issueTechnical(error instanceof HumanAuthError && error.code === 'INVALID_TOKEN'
            ? 'AUTHENTICATION_FAILED'
            : 'AUTH_UNAVAILABLE'),
        });
      }
      try {
        const result = await invokeManagement(
          createQualification,
          updateQualification,
          revokeQualification,
          payload,
          context.receivedAtMs,
          actorId,
        );
        const safe = result;
        const status = safe.operation === 'CREATE' ? 201 : 200;
        const responsePayload: Readonly<Record<string, unknown>> = safe.operation === 'CREATE'
          ? { operation: safe.operation, qualificationId: safe.qualificationId, summary: safe.summary, qrToken: safe.qrToken }
          : { operation: safe.operation, qualificationId: safe.qualificationId, summary: safe.summary };
        return Object.freeze({
          disposition: 'BUSINESS_RESULT_PERSISTED',
          response: issueBusiness(status, responsePayload),
        });
      } catch (error: unknown) {
        return classifyManagementFailure(error, issueTechnical, issueBusiness);
      }
    },
  });
  return Object.freeze({ validator, work });
}

async function invokeManagement(
  createQualification: ManageQualifications['create'],
  updateQualification: ManageQualifications['update'],
  revokeQualification: ManageQualifications['revoke'],
  payload: ManagementPayload,
  receivedAtMs: number,
  actorId: string,
) {
  if (payload.body.kind === 'CREATE') {
    const input: CreateQualificationCommand = {
      displayName: payload.body.displayName,
      validFromMs: payload.body.validFromMs,
      validUntilMs: payload.body.validUntilMs,
      faceMapping: payload.body.face,
      receivedAtMs,
      actorId,
    };
    return createQualification(input);
  }
  if (payload.body.kind === 'UPDATE') {
    const input: UpdateQualificationCommand = {
      qualificationId: payload.qualificationId!,
      ...(Object.hasOwn(payload.body.fields, 'displayName') ? { displayName: payload.body.fields.displayName } : {}),
      ...(Object.hasOwn(payload.body.fields, 'validFromMs') ? { validFromMs: payload.body.fields.validFromMs } : {}),
      ...(Object.hasOwn(payload.body.fields, 'validUntilMs') ? { validUntilMs: payload.body.fields.validUntilMs } : {}),
      ...(Object.hasOwn(payload.body.fields, 'face') ? { faceMapping: payload.body.fields.face } : {}),
      receivedAtMs,
      actorId,
    };
    return updateQualification(input);
  }
  const input: RevokeQualificationCommand = {
    qualificationId: payload.qualificationId!,
    reason: payload.body.reason,
    receivedAtMs,
    actorId,
  };
  return revokeQualification(input);
}

function classifyManagementFailure(
  error: unknown,
  issueTechnical: (code: 'AUTHENTICATION_FAILED' | 'AUTH_UNAVAILABLE' | 'FORBIDDEN' | 'MANAGEMENT_CONFLICT' | 'PERSISTENCE_UNAVAILABLE' | 'FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED') => HttpResponsePlan,
  issueBusiness: (status: 200 | 201 | 202 | 409, payload: Readonly<Record<string, unknown>>) => HttpResponsePlan,
): AdmissionWriterOutcome {
  if (error instanceof ManagementApplicationError) {
    const response = issueBusiness(409, Object.freeze({ code: error.code }));
    return Object.freeze({
      disposition: error.effect === 'EXPIRED_TERMINAL_PERSISTED' ? 'BUSINESS_RESULT_PERSISTED' : 'KNOWN_NO_EFFECT',
      response,
    });
  }
  if (error instanceof G04bTransactionError) {
    const kind = error.facts.kind;
    if (kind === 'FACE_SUBJECT_ALREADY_BOUND') {
      return Object.freeze({ disposition: 'KNOWN_NO_EFFECT', response: issueBusiness(409, Object.freeze({ code: kind })) });
    }
    if (kind === 'FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED') {
      return Object.freeze({ disposition: 'KNOWN_NO_EFFECT', response: issueTechnical('FACE_SUBJECT_SLOT_CAPACITY_EXHAUSTED') });
    }
    return Object.freeze({ disposition: 'UNKNOWN_EFFECT', response: issueTechnical('PERSISTENCE_UNAVAILABLE') });
  }
  return Object.freeze({ disposition: 'UNKNOWN_EFFECT', response: issueTechnical('PERSISTENCE_UNAVAILABLE') });
}

function parseBody(routeId: ManagementRouteId, body: unknown): CreateBody | UpdateBody | RevokeBody {
  if (!isRecord(body)) throw new TypeError('management body must be an object');
  if (routeId === 'QUALIFICATION_CREATE') {
    exactKeys(body, ['displayName', 'face', 'validFrom', 'validUntil']);
    return Object.freeze({
      kind: 'CREATE',
      displayName: text(body.displayName, 1, 128),
      validFromMs: timestamp(body.validFrom),
      validUntilMs: timestamp(body.validUntil),
      face: body.face === null ? null : faceMapping(body.face),
    });
  }
  if (routeId === 'QUALIFICATION_UPDATE') {
    const allowed = ['displayName', 'face', 'validFrom', 'validUntil'];
    exactKeys(body, allowed.filter((key) => Object.hasOwn(body, key)));
    if (Object.keys(body).length === 0) throw new TypeError('update body must have a field');
    const fields: Record<string, unknown> = {};
    if (Object.hasOwn(body, 'displayName')) fields.displayName = text(body.displayName, 1, 128);
    if (Object.hasOwn(body, 'validFrom')) fields.validFromMs = timestamp(body.validFrom);
    if (Object.hasOwn(body, 'validUntil')) fields.validUntilMs = timestamp(body.validUntil);
    if (Object.hasOwn(body, 'face')) fields.face = body.face === null ? null : faceMapping(body.face);
    return Object.freeze({ kind: 'UPDATE', fields: Object.freeze(fields) as UpdateBody['fields'] });
  }
  exactKeys(body, ['reason']);
  return Object.freeze({ kind: 'REVOKE', reason: text(body.reason, 1, 512) });
}

function faceMapping(value: unknown): FaceMappingInput {
  if (!isRecord(value)) throw new TypeError('faceMapping must be an object or null');
  exactKeys(value, ['externalSubjectId', 'provider']);
  const provider = typeof value.provider === 'string' ? value.provider : (() => { throw new TypeError('invalid provider'); })();
  const externalSubjectId = typeof value.externalSubjectId === 'string' ? value.externalSubjectId : (() => { throw new TypeError('invalid subject'); })();
  assertProvider(provider);
  assertExternalSubjectId(externalSubjectId);
  return Object.freeze({ provider, externalSubjectId });
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value)) throw new TypeError('invalid timestamp');
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new TypeError('timestamp must round-trip as ISO');
  return date.getTime();
}

function text(value: unknown, minBytes: number, maxBytes: number): string {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value) || CONTROL.test(value)) throw new TypeError('invalid text');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < minBytes || bytes > maxBytes) throw new TypeError('text byte length is out of range');
  return value;
}

function parsePathId(value: string | undefined): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new TypeError('qualification ID is invalid');
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError('management DTO keys are invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnpairedSurrogate(value: string): boolean {
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

function isManagementRoute(routeId: BusinessRouteId): routeId is ManagementRouteId {
  return routeId === 'QUALIFICATION_CREATE' || routeId === 'QUALIFICATION_UPDATE' || routeId === 'QUALIFICATION_REVOKE';
}

function assertOptions(options: G08aManagementCompositionOptions): void {
  if (typeof options !== 'object' || options === null
    || typeof options.auth !== 'object' || options.auth === null
    || typeof options.auth.verifyAccessToken !== 'function'
    || typeof options.auth.assertRole !== 'function'
    || typeof options.auth.facts !== 'function'
    || typeof options.manageQualifications !== 'object' || options.manageQualifications === null
    || typeof options.manageQualifications.create !== 'function'
    || typeof options.manageQualifications.update !== 'function'
    || typeof options.manageQualifications.revoke !== 'function'
    || typeof options.responsePlans !== 'object' || options.responsePlans === null
    || typeof options.responsePlans.technical?.issue !== 'function'
    || typeof options.responsePlans.business?.issue !== 'function'
    || typeof options.workHandoff !== 'object' || options.workHandoff === null
    || typeof options.workHandoff.issuer?.issue !== 'function') {
    throw new TypeError('invalid G08a management composition options');
  }
}
