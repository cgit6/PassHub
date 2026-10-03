import type { G11cMaintenanceEffects, G11cMaintenanceResult } from './g11c-maintenance-lifecycle-engine.js';
import { createG11cMaintenanceLifecycle } from './g11c-maintenance-lifecycle-engine.js';
import type { G11cMaintenanceMarkerAdapter } from './g11c-maintenance-marker.js';
import type { G11cPrivateDrainAdapter } from './g11c-private-drain.js';

export interface G11cMaintenanceProcessEffects {
  readonly requestApiStop: () => Promise<void>;
  readonly awaitApiProcessGone: () => Promise<void>;
  readonly requestMongoStop: () => Promise<void>;
  readonly awaitMongoProcessGone: () => Promise<void>;
  readonly awaitMongoPrimary: () => Promise<void>;
  readonly verifyNoLateWork: () => Promise<void>;
}

export interface G11cMaintenanceCompositionOptions {
  readonly marker: G11cMaintenanceMarkerAdapter;
  readonly drain: G11cPrivateDrainAdapter;
  readonly process: G11cMaintenanceProcessEffects;
}

export interface G11cMaintenanceComposition {
  readonly run: (drainTimeoutMs: number) => Promise<G11cMaintenanceResult>;
  /** Read-only diagnostic projection; the lifecycle owner stays private. */
  readonly snapshot: () => G11cMaintenanceResult;
}

/**
 * Private production composition for the first G11c slice.  Process effects
 * remain explicit ports until the Docker controller slice owns process IDs;
 * this function nevertheless wires the real persistent marker and real G10a
 * drain adapter into the one-shot lifecycle without publishing either as API.
 */
export function createG11cMaintenanceComposition(input: G11cMaintenanceCompositionOptions): G11cMaintenanceComposition {
  const options = captureOptions(input);
  const lifecycle = createG11cMaintenanceLifecycle();
  const effects: G11cMaintenanceEffects = Object.freeze({
    acquirePersistentMarker: options.marker.acquire,
    drainPrivateRuntime: options.drain.drain,
    requestApiStop: options.process.requestApiStop,
    awaitApiProcessGone: options.process.awaitApiProcessGone,
    requestMongoStop: options.process.requestMongoStop,
    awaitMongoProcessGone: options.process.awaitMongoProcessGone,
    awaitMongoPrimary: options.process.awaitMongoPrimary,
    verifyNoLateWork: options.process.verifyNoLateWork,
  });
  return Object.freeze({
    run: (drainTimeoutMs: number) => lifecycle.run(effects, drainTimeoutMs),
    snapshot: () => lifecycle.snapshot(),
  });
}

function captureOptions(input: G11cMaintenanceCompositionOptions): Readonly<G11cMaintenanceCompositionOptions> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Reflect.ownKeys(input).length !== 3
    || typeof input.marker !== 'object' || input.marker === null || typeof input.marker.acquire !== 'function'
    || typeof input.drain !== 'object' || input.drain === null || typeof input.drain.drain !== 'function'
    || typeof input.process !== 'object' || input.process === null || Reflect.ownKeys(input.process).length !== 6
    || Object.values(input.process).some((value) => typeof value !== 'function')) {
    throw new TypeError('invalid G11c maintenance composition options');
  }
  return Object.freeze({ marker: input.marker, drain: input.drain, process: input.process });
}
