import {
  assertRuntimeControl,
  type ActiveQueryReadLease,
  type RuntimeControl,
} from '../../runtime/internal/runtime-control.js';

/** Internal-only capability acquired exactly at the G07 query-work seam. */
export interface G10aQueryPermissionBinding {
  /** Pure ingress veto: must not increment drain counters. */
  isMaintenanceQueryVeto(): boolean;
  acquireActiveQueryRead(): ActiveQueryReadLease;
}

interface BindingState {
  readonly veto: () => boolean;
  readonly acquire: () => ActiveQueryReadLease;
}

const bindingStates = new WeakMap<object, BindingState>();

export function createG10aQueryPermissionBinding(value: unknown): G10aQueryPermissionBinding {
  assertRuntimeControl(value);
  const control = value as RuntimeControl;
  const veto = control.isMaintenanceWriterVeto.bind(control);
  const acquire = control.acquireActiveQueryRead.bind(control);
  const binding = Object.freeze({
    isMaintenanceQueryVeto(this: unknown): boolean {
      if ((typeof this !== 'object' && typeof this !== 'function') || this === null) {
        throw new TypeError('query permission binding receiver is invalid');
      }
      const state = bindingStates.get(this);
      if (state === undefined) throw new TypeError('query permission binding is foreign');
      return state.veto();
    },
    acquireActiveQueryRead(this: unknown): ActiveQueryReadLease {
      if ((typeof this !== 'object' && typeof this !== 'function') || this === null) {
        throw new TypeError('query permission binding receiver is invalid');
      }
      const state = bindingStates.get(this);
      if (state === undefined) throw new TypeError('query permission binding is foreign');
      return state.acquire();
    },
  });
  bindingStates.set(binding, Object.freeze({ veto, acquire }));
  return binding;
}

export function assertG10aQueryPermissionBinding(
  value: unknown,
): asserts value is G10aQueryPermissionBinding {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || bindingStates.get(value) === undefined) {
    throw new TypeError('query permission binding is not trusted');
  }
}
