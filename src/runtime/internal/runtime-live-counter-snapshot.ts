/** Nominal push-only STATUS counter source. RuntimeControl never pulls it. */
export interface RuntimeLiveCounterSnapshot {
  readonly writers: Readonly<{ readonly provisional: number; readonly queued: number; readonly running: number; readonly blocked: number; readonly unknown: number }>;
  readonly registryUnknown: number;
}
export interface RuntimeLiveCounterSnapshotSource { readonly __runtimeLiveCounterSnapshotSource: unique symbol; }
type Listener = (snapshot: RuntimeLiveCounterSnapshot) => void;
interface State { snapshot: RuntimeLiveCounterSnapshot; listener: Listener | undefined; }
const sources = new WeakMap<object, State>();

export function createRuntimeLiveCounterSnapshotSource(initial: RuntimeLiveCounterSnapshot): RuntimeLiveCounterSnapshotSource {
  const source = Object.freeze({}) as RuntimeLiveCounterSnapshotSource;
  sources.set(source as object, { snapshot: capture(initial), listener: undefined });
  return source;
}
export function assertRuntimeLiveCounterSnapshotSource(value: unknown): asserts value is RuntimeLiveCounterSnapshotSource {
  if (typeof value !== 'object' || value === null || !sources.has(value)) throw new TypeError('runtime live counter source is not trusted');
}
export function publishRuntimeLiveCounterSnapshot(source: RuntimeLiveCounterSnapshotSource, value: RuntimeLiveCounterSnapshot): void {
  assertRuntimeLiveCounterSnapshotSource(source);
  const state = sources.get(source as object)!;
  state.snapshot = capture(value);
  try { state.listener?.(state.snapshot); } catch { /* metrics cannot alter lifecycle */ }
}
export function bindRuntimeLiveCounterSnapshot(source: RuntimeLiveCounterSnapshotSource, listener: Listener): void {
  assertRuntimeLiveCounterSnapshotSource(source);
  if (typeof listener !== 'function') throw new TypeError('runtime live counter listener is invalid');
  const state = sources.get(source as object)!;
  if (state.listener !== undefined) throw new TypeError('runtime live counter source is already bound');
  state.listener = listener;
  listener(state.snapshot);
}
function capture(value: unknown): RuntimeLiveCounterSnapshot {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('runtime live counters are invalid');
  const writers = Object.getOwnPropertyDescriptor(value, 'writers')?.value;
  const registryUnknown = Object.getOwnPropertyDescriptor(value, 'registryUnknown')?.value;
  if (typeof writers !== 'object' || writers === null || Object.getPrototypeOf(writers) !== Object.prototype || !Number.isSafeInteger(registryUnknown) || registryUnknown < 0) throw new TypeError('runtime live counters are invalid');
  const counts: Record<string, number> = {};
  for (const key of ['provisional', 'queued', 'running', 'blocked', 'unknown']) { const count = Object.getOwnPropertyDescriptor(writers, key)?.value; if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('runtime live counters are invalid'); counts[key] = count; }
  return Object.freeze({ writers: Object.freeze({ provisional: counts.provisional!, queued: counts.queued!, running: counts.running!, blocked: counts.blocked!, unknown: counts.unknown! }), registryUnknown });
}
