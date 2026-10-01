import { types as nodeTypes } from 'node:util';

import type { CommandFailedEvent, CommandStartedEvent, CommandSucceededEvent, MongoClient } from 'mongodb';

import { readRuntimeDriverLogContext, type RuntimeDriverLogContext } from '../../runtime/internal/runtime-driver-log-context.js';
import { createRuntimeLogRecord, type RuntimeLogCommandName } from '../../runtime/internal/runtime-log-schema.js';

const monitoredClients = new WeakSet<object>();
const commands = new Set<Exclude<RuntimeLogCommandName, null>>([
  'find', 'aggregate', 'insert', 'update', 'delete', 'findAndModify',
  'commitTransaction', 'abortTransaction', 'endSessions',
]);
const PENDING_LIMIT = 4096;
const PENDING_TTL_MS = 30_000;

interface PendingCommand {
  readonly key: string;
  readonly context: RuntimeDriverLogContext;
  readonly commandName: Exclude<RuntimeLogCommandName, null>;
  readonly requestId: number;
  readonly expiry: ReturnType<typeof setTimeout>;
}

interface StartedFacts {
  readonly key: string;
  readonly requestId: number;
  readonly commandName: Exclude<RuntimeLogCommandName, null>;
}

/** Binds to official driver command-monitoring events; it retains no payloads. */
export function bindG10aMongoCommandMonitoring(client: MongoClient): void {
  if (monitoredClients.has(client)) return;
  monitoredClients.add(client);
  const pending = new Map<string, PendingCommand>();

  const clear = (): void => {
    for (const item of pending.values()) clearTimeout(item.expiry);
    pending.clear();
  };
  const complete = (event: unknown, code: 'DRIVER_SUCCEEDED' | 'DRIVER_FAILED'): void => {
    const key = captureEventKey(event);
    if (key === null) return;
    const item = pending.get(key);
    if (item === undefined) return;
    pending.delete(key);
    clearTimeout(item.expiry);
    append(item, code);
  };

  client.on('commandStarted', (event: CommandStartedEvent) => {
    const facts = captureStarted(event);
    const context = readRuntimeDriverLogContext();
    if (facts === null || context === undefined || pending.size >= PENDING_LIMIT) return;
    if (pending.has(facts.key)) return;
    const expiry = setTimeout(() => {
      const current = pending.get(facts.key);
      if (current !== undefined && current.expiry === expiry) pending.delete(facts.key);
    }, PENDING_TTL_MS);
    expiry.unref();
    const item: PendingCommand = Object.freeze({ ...facts, context, expiry });
    pending.set(facts.key, item);
    append(item, 'DRIVER_STARTED');
  });
  client.on('commandSucceeded', (event: CommandSucceededEvent) => complete(event, 'DRIVER_SUCCEEDED'));
  client.on('commandFailed', (event: CommandFailedEvent) => complete(event, 'DRIVER_FAILED'));

  // Terminal monitor events normally arrive in the same driver turn before
  // teardown. Deferring cleanup one turn preserves those terminals while a
  // pool/client close cannot retain attribution contexts indefinitely.
  const clearAfterCurrentTurn = (): void => { setImmediate(clear).unref(); };
  client.on('connectionPoolCleared', clearAfterCurrentTurn);
  client.on('connectionPoolClosed', clearAfterCurrentTurn);
  client.on('topologyClosed', clearAfterCurrentTurn);
  client.on('close', clearAfterCurrentTurn);
}

function captureStarted(event: unknown): StartedFacts | null {
  const base = captureEventBase(event);
  if (base === null) return null;
  const commandName = capturedOwnData(event as object, 'commandName');
  if (typeof commandName !== 'string' || !commands.has(commandName as Exclude<RuntimeLogCommandName, null>)) return null;
  return Object.freeze({ ...base, commandName: commandName as Exclude<RuntimeLogCommandName, null> });
}

function captureEventKey(event: unknown): string | null { return captureEventBase(event)?.key ?? null; }

function captureEventBase(event: unknown): Readonly<{ readonly key: string; readonly requestId: number }> | null {
  if (typeof event !== 'object' || event === null || nodeTypes.isProxy(event)) return null;
  const requestId = capturedOwnData(event, 'requestId');
  const connectionId = capturedOwnData(event, 'connectionId');
  if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId < 0) return null;
  const connection = connectionKey(connectionId);
  return connection === null ? null : Object.freeze({ key: `${connection}:${requestId}`, requestId });
}

function capturedOwnData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function connectionKey(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? `n:${value}` : null;
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > 256 || value.includes('\u0000')) return null;
    return `s:${JSON.stringify(value)}`;
  }
  return null;
}

function append(item: PendingCommand, code: 'DRIVER_STARTED' | 'DRIVER_SUCCEEDED' | 'DRIVER_FAILED'): void {
  try {
    item.context.runtimeLogSink.append(createRuntimeLogRecord({
      schemaVersion: 'g10a.log.v1', timestamp: new Date().toISOString(), kind: 'DRIVER', code,
      requestUUID: item.context.requestUUID, operationUUID: item.context.operationUUID,
      datasetEpoch: item.context.datasetEpoch, processRunId: item.context.processRunId,
      ownerRef: item.context.ownerRef, route: item.context.route, phase: 'DRIVER',
      round: null, group: null, budgetRemainingMs: null, budgetRemainingUnits: null,
      commandName: item.commandName, driverRequestId: item.requestId,
      requestControlId: null, controlId: null, revision: null,
    }));
  } catch { /* monitoring never changes Mongo work */ }
}
