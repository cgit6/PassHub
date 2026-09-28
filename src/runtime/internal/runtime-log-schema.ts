import { Buffer } from 'node:buffer';
import { types as nodeTypes } from 'node:util';

/**
 * The logger is deliberately separated from this module.  This file owns only
 * the closed, safe-to-serialize record contract shared by writers and readers.
 */
export const RUNTIME_LOG_SCHEMA_VERSION = 'g10a.log.v1' as const;
export const RUNTIME_LOG_MAX_BYTES = 2_048;

export type RuntimeLogKind = 'RUNTIME' | 'DRIVER' | 'CONTROL';
export type RuntimeLogCode =
  | 'REQUEST_ACCEPTED'
  | 'OPERATION_REGISTERED' | 'OPERATION_BLOCKED'
  | 'BUSINESS_STEP_REGISTERED' | 'BUSINESS_STEP_ISSUED' | 'BUSINESS_STEP_SETTLED'
  | 'DRIVER_STARTED' | 'DRIVER_SUCCEEDED' | 'DRIVER_FAILED'
  | 'HOLD_ACKNOWLEDGED' | 'RELEASE_ACKNOWLEDGED' | 'DRAIN_STARTED' | 'DRAINED' | 'DRAIN_NOT_DRAINED' | 'CONTROL_REJECTED';
export type RuntimeLogRoute =
  | 'MANAGEMENT_CREATE' | 'MANAGEMENT_UPDATE' | 'MANAGEMENT_REVOKE' | 'RECOGNITION'
  | 'QUERY' | 'LOGIN' | 'CONTROL' | null;
export type RuntimeLogPhase = 'INGRESS' | 'ADMISSION' | 'PERSISTENCE' | 'DRIVER' | 'CONTROL' | null;
export type RuntimeLogGroup = 'EXECUTION' | 'CONFIRMATION' | null;
export type RuntimeLogCommandName =
  | 'find' | 'aggregate' | 'insert' | 'update' | 'delete' | 'findAndModify'
  | 'commitTransaction' | 'abortTransaction' | 'endSessions' | null;

/** Exact 20-key on-disk record.  It intentionally contains no Error/object payload. */
export interface RuntimeLogRecord {
  readonly schemaVersion: typeof RUNTIME_LOG_SCHEMA_VERSION;
  readonly timestamp: string;
  readonly kind: RuntimeLogKind;
  readonly code: RuntimeLogCode;
  readonly requestUUID: string | null;
  readonly operationUUID: string | null;
  readonly datasetEpoch: string;
  readonly processRunId: string;
  readonly ownerRef: string | null;
  readonly route: RuntimeLogRoute;
  readonly phase: RuntimeLogPhase;
  readonly round: number | null;
  readonly group: RuntimeLogGroup;
  readonly budgetRemainingMs: number | null;
  readonly budgetRemainingUnits: number | null;
  readonly commandName: RuntimeLogCommandName;
  readonly driverRequestId: number | null;
  readonly requestControlId: string | null;
  readonly controlId: string | null;
  readonly revision: string | null;
}

export class RuntimeLogSchemaError extends TypeError {
  readonly code: 'INVALID_RECORD' | 'OVERSIZE';
  constructor(code: 'INVALID_RECORD' | 'OVERSIZE') {
    super(code);
    this.name = 'RuntimeLogSchemaError';
    this.code = code;
  }
}

const keys = [
  'schemaVersion', 'timestamp', 'kind', 'code', 'requestUUID', 'operationUUID', 'datasetEpoch', 'processRunId', 'ownerRef',
  'route', 'phase', 'round', 'group', 'budgetRemainingMs', 'budgetRemainingUnits', 'commandName', 'driverRequestId',
  'requestControlId', 'controlId', 'revision',
] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revisionPattern = /^(?:0|[1-9][0-9]*)$/;
const codeSet = new Set<RuntimeLogCode>([
  'REQUEST_ACCEPTED', 'OPERATION_REGISTERED', 'OPERATION_BLOCKED', 'BUSINESS_STEP_REGISTERED', 'BUSINESS_STEP_ISSUED', 'BUSINESS_STEP_SETTLED',
  'DRIVER_STARTED', 'DRIVER_SUCCEEDED', 'DRIVER_FAILED', 'HOLD_ACKNOWLEDGED', 'RELEASE_ACKNOWLEDGED', 'DRAIN_STARTED', 'DRAINED', 'DRAIN_NOT_DRAINED', 'CONTROL_REJECTED',
]);
const businessRoutes = new Set(['MANAGEMENT_CREATE', 'MANAGEMENT_UPDATE', 'MANAGEMENT_REVOKE', 'RECOGNITION']);
const readRoutes = new Set(['QUERY', 'LOGIN']);
const driverCommands = new Set(['find', 'aggregate', 'insert', 'update', 'delete', 'findAndModify', 'commitTransaction', 'abortTransaction', 'endSessions']);
const businessStepCodes = new Set(['BUSINESS_STEP_REGISTERED', 'BUSINESS_STEP_ISSUED', 'BUSINESS_STEP_SETTLED']);
const operationCodes = new Set(['OPERATION_REGISTERED', 'OPERATION_BLOCKED']);
const driverCodes = new Set(['DRIVER_STARTED', 'DRIVER_SUCCEEDED', 'DRIVER_FAILED']);
const controlCodes = new Set(['HOLD_ACKNOWLEDGED', 'RELEASE_ACKNOWLEDGED', 'DRAIN_STARTED', 'DRAINED', 'DRAIN_NOT_DRAINED', 'CONTROL_REJECTED']);
const controlCodesWithId = new Set(['HOLD_ACKNOWLEDGED', 'RELEASE_ACKNOWLEDGED', 'DRAIN_STARTED', 'DRAINED', 'DRAIN_NOT_DRAINED']);

/** Captures and validates an untrusted candidate without retaining its object graph. */
export function createRuntimeLogRecord(input: unknown): RuntimeLogRecord {
  const value = captureClosedRecord(input);
  validateRecord(value);
  const record = Object.freeze({ ...value }) as RuntimeLogRecord;
  // The exact bytes are part of the record contract, not a best-effort logger concern.
  encodeRuntimeLogRecord(record);
  return record;
}

/** Validates then returns the canonical frozen copy; useful to readers of NDJSON. */
export function validateRuntimeLogRecord(input: unknown): RuntimeLogRecord {
  return createRuntimeLogRecord(input);
}

/** Returns exactly one UTF-8 NDJSON line. */
export function encodeRuntimeLogRecord(record: RuntimeLogRecord): string {
  // Revalidate here: callers cannot turn a forged structural cast into output.
  const canonical = captureClosedRecord(record);
  validateRecord(canonical);
  const line = `${JSON.stringify(canonical)}\n`;
  if (Buffer.byteLength(line, 'utf8') > RUNTIME_LOG_MAX_BYTES) throw new RuntimeLogSchemaError('OVERSIZE');
  return line;
}

function captureClosedRecord(input: unknown): Record<(typeof keys)[number], unknown> {
  if (typeof input !== 'object' || input === null || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string') || keys.some((key) => !ownKeys.includes(key))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const captured = {} as Record<(typeof keys)[number], unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    captured[key] = descriptor.value;
  }
  return captured;
}

function validateRecord(record: Record<(typeof keys)[number], unknown>): asserts record is RuntimeLogRecord {
  if (record.schemaVersion !== RUNTIME_LOG_SCHEMA_VERSION || !isCanonicalIsoMs(record.timestamp) || !isOneOf(record.kind, ['RUNTIME', 'DRIVER', 'CONTROL']) || !isCode(record.code)) invalid();
  uuidOrNull(record.requestUUID); uuidOrNull(record.operationUUID); uuid(record.datasetEpoch); uuid(record.processRunId); uuidOrNull(record.ownerRef);
  if (!isRoute(record.route) || !isPhase(record.phase) || !isRound(record.round) || !isGroup(record.group) || !isBudgetMs(record.budgetRemainingMs) || !isBudgetUnits(record.budgetRemainingUnits) || !isCommand(record.commandName) || !isDriverRequestId(record.driverRequestId) || !isRevision(record.revision)) invalid();
  uuidOrNull(record.requestControlId); uuidOrNull(record.controlId);

  if (record.code === 'REQUEST_ACCEPTED') {
    requireCondition(record.kind === 'RUNTIME' && record.phase === 'INGRESS' && record.requestUUID !== null && record.operationUUID === null && record.ownerRef === null && routeIsBusinessOrRead(record.route));
    requireNull(record.round, record.group, record.budgetRemainingMs, record.budgetRemainingUnits, record.commandName, record.driverRequestId, record.requestControlId, record.controlId, record.revision);
    return;
  }
  if (operationCodes.has(record.code)) {
    requireBusinessOperation(record as unknown as RuntimeLogRecord, 'ADMISSION');
    requireNull(record.round, record.group, record.budgetRemainingMs, record.budgetRemainingUnits, record.commandName, record.driverRequestId, record.requestControlId, record.controlId, record.revision);
    return;
  }
  if (businessStepCodes.has(record.code)) {
    requireBusinessOperation(record as unknown as RuntimeLogRecord, 'PERSISTENCE');
    requireNull(record.commandName, record.driverRequestId, record.requestControlId, record.controlId, record.revision);
    const budgets = [record.round, record.group, record.budgetRemainingMs, record.budgetRemainingUnits];
    requireCondition(budgets.every((value) => value === null) || budgets.every((value) => value !== null));
    return;
  }
  if (driverCodes.has(record.code)) {
    requireCondition(record.kind === 'DRIVER' && record.phase === 'DRIVER' && record.requestUUID !== null && record.commandName !== null && record.driverRequestId !== null && routeIsBusinessOrRead(record.route));
    if (isBusinessRoute(record.route)) requireCondition(record.operationUUID !== null && record.ownerRef !== null);
    else requireCondition(record.operationUUID === null && record.ownerRef === null);
    requireNull(record.round, record.group, record.budgetRemainingMs, record.budgetRemainingUnits, record.requestControlId, record.controlId, record.revision);
    return;
  }
  if (controlCodes.has(record.code)) {
    requireCondition(record.kind === 'CONTROL' && record.route === 'CONTROL' && record.phase === 'CONTROL' && record.requestControlId !== null && record.revision !== null);
    requireNull(record.requestUUID, record.operationUUID, record.ownerRef, record.round, record.group, record.budgetRemainingMs, record.budgetRemainingUnits, record.commandName, record.driverRequestId);
    if (controlCodesWithId.has(record.code)) requireCondition(record.controlId !== null);
    else requireCondition(record.controlId === null);
    return;
  }
  invalid();
}

function requireBusinessOperation(record: RuntimeLogRecord, phase: 'ADMISSION' | 'PERSISTENCE'): void {
  requireCondition(record.kind === 'RUNTIME' && record.phase === phase && record.requestUUID !== null && record.operationUUID !== null && record.ownerRef !== null && isBusinessRoute(record.route));
}
function requireCondition(condition: boolean): asserts condition { if (!condition) invalid(); }
function requireNull(...values: readonly unknown[]): void { requireCondition(values.every((value) => value === null)); }
function invalid(): never { throw new RuntimeLogSchemaError('INVALID_RECORD'); }
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !uuidPattern.test(value)) invalid(); }
function uuidOrNull(value: unknown): void { if (value !== null) uuid(value); }
function isCanonicalIsoMs(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isSafeInteger(millis) && new Date(millis).toISOString() === value;
}
function isOneOf(value: unknown, values: readonly string[]): boolean { return typeof value === 'string' && values.includes(value); }
function isCode(value: unknown): value is RuntimeLogCode { return typeof value === 'string' && codeSet.has(value as RuntimeLogCode); }
function isRoute(value: unknown): value is RuntimeLogRoute { return value === null || isOneOf(value, ['MANAGEMENT_CREATE', 'MANAGEMENT_UPDATE', 'MANAGEMENT_REVOKE', 'RECOGNITION', 'QUERY', 'LOGIN', 'CONTROL']); }
function isPhase(value: unknown): value is RuntimeLogPhase { return value === null || isOneOf(value, ['INGRESS', 'ADMISSION', 'PERSISTENCE', 'DRIVER', 'CONTROL']); }
function isRound(value: unknown): value is number | null { return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3); }
function isGroup(value: unknown): value is RuntimeLogGroup { return value === null || value === 'EXECUTION' || value === 'CONFIRMATION'; }
function isBudgetMs(value: unknown): value is number | null { return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 15_000); }
function isBudgetUnits(value: unknown): value is number | null { return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 7); }
function isCommand(value: unknown): value is RuntimeLogCommandName { return value === null || (typeof value === 'string' && driverCommands.has(value)); }
function isDriverRequestId(value: unknown): value is number | null { return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0); }
function isRevision(value: unknown): value is string | null { return value === null || (typeof value === 'string' && revisionPattern.test(value)); }
function isBusinessRoute(value: RuntimeLogRoute): value is 'MANAGEMENT_CREATE' | 'MANAGEMENT_UPDATE' | 'MANAGEMENT_REVOKE' | 'RECOGNITION' { return typeof value === 'string' && businessRoutes.has(value); }
function routeIsBusinessOrRead(value: RuntimeLogRoute): boolean { return isBusinessRoute(value) || (typeof value === 'string' && readRoutes.has(value)); }
