import { AsyncLocalStorage } from 'node:async_hooks';

import type { RuntimeLogSink } from './runtime-log-sink.js';
import type { RuntimeLogRoute } from './runtime-log-schema.js';

/**
 * Private async attribution transported only while an already accepted
 * application operation invokes Mongo.  It is deliberately not an HTTP DTO
 * and not exported from any public barrel.
 */
export interface RuntimeDriverLogContext {
  readonly runtimeLogSink: RuntimeLogSink;
  readonly requestUUID: string;
  readonly operationUUID: string | null;
  readonly datasetEpoch: string;
  readonly processRunId: string;
  readonly ownerRef: string | null;
  readonly route: Exclude<RuntimeLogRoute, null | 'CONTROL'>;
}

const storage = new AsyncLocalStorage<RuntimeDriverLogContext>();

export function runWithRuntimeDriverLogContext<T>(
  context: RuntimeDriverLogContext,
  operation: () => T,
): T {
  return storage.run(context, operation);
}

export function readRuntimeDriverLogContext(): RuntimeDriverLogContext | undefined {
  return storage.getStore();
}
