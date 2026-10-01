/** Opaque one-time composition bridge; notifications cannot re-enter refresh. */
export interface RuntimeLiveCounterBridge { readonly __runtimeLiveCounterBridge: unique symbol; }
interface State { readonly refresh: () => void; notifying: boolean; }
const bridges = new WeakMap<object, State>();
let notifyingDepth = 0;
export function isRuntimeLiveCounterBridgeNotifying(): boolean { return notifyingDepth !== 0; }
export function createRuntimeLiveCounterBridge(refresh: () => void): RuntimeLiveCounterBridge {
  if (typeof refresh !== 'function') throw new TypeError('runtime counter bridge refresh is invalid');
  const bridge = Object.freeze({}) as RuntimeLiveCounterBridge;
  bridges.set(bridge as object, { refresh, notifying: false }); return bridge;
}
export function assertRuntimeLiveCounterBridge(value: unknown): asserts value is RuntimeLiveCounterBridge {
  if (typeof value !== 'object' || value === null || !bridges.has(value)) throw new TypeError('runtime counter bridge is not trusted');
}
export function notifyRuntimeLiveCounterBridge(bridge: RuntimeLiveCounterBridge): void {
  assertRuntimeLiveCounterBridge(bridge); const state = bridges.get(bridge as object)!;
  if (state.notifying) throw new TypeError('runtime counter bridge is reentrant');
  state.notifying = true; notifyingDepth += 1; try { state.refresh(); } finally { notifyingDepth -= 1; state.notifying = false; }
}
