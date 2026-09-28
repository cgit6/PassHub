import {
  assertRuntimeControl,
  type IssuedPersistenceLease,
  type RuntimeControl,
} from '../../runtime/internal/runtime-control.js';

/** Internal-only capability used by G07b at the exact G08 invocation seam. */
export interface G10aWriterPermissionBinding {
  acquireIssuedPersistence(): IssuedPersistenceLease;
  canStartWriter(): boolean;
  isMaintenanceWriterVeto(): boolean;
  bindWriterWake(wake: () => void): void;
  bindMaintenanceReadySettlement(settle: () => void): void;
}

interface BindingState {
  readonly control: RuntimeControl;
  readonly acquire: () => IssuedPersistenceLease;
  readonly canStartWriter: () => boolean;
  readonly isMaintenanceWriterVeto: () => boolean;
  readonly bindWriterWake: (wake: () => void) => void;
  readonly bindMaintenanceReadySettlement: (settle: () => void) => void;
}

const bindingStates = new WeakMap<object, BindingState>();

export function createG10aWriterPermissionBinding(value: unknown): G10aWriterPermissionBinding {
  assertRuntimeControl(value);
  const control = value as RuntimeControl;
  const acquire = control.acquireIssuedPersistence.bind(control);
  const canStartWriter = control.canStartWriter.bind(control);
  const isMaintenanceWriterVeto = control.isMaintenanceWriterVeto.bind(control);
  const bindWriterWake = control.bindWriterWake.bind(control);
  const bindMaintenanceReadySettlement = control.bindMaintenanceReadySettlement.bind(control);
  const binding = Object.freeze({
    acquireIssuedPersistence(this: unknown): IssuedPersistenceLease {
      if ((typeof this !== 'object' && typeof this !== 'function') || this === null) {
        throw new TypeError('writer permission binding receiver is invalid');
      }
      const state = bindingStates.get(this);
      if (state === undefined) throw new TypeError('writer permission binding is foreign');
      return state.acquire();
    },
    canStartWriter(this: unknown): boolean {
      if ((typeof this !== 'object' && typeof this !== 'function') || this === null) throw new TypeError('writer permission binding receiver is invalid');
      const state = bindingStates.get(this);
      if (state === undefined) throw new TypeError('writer permission binding is foreign');
      return state.canStartWriter();
    },
    isMaintenanceWriterVeto(this: unknown): boolean {
      if ((typeof this !== 'object' && typeof this !== 'function') || this === null) throw new TypeError('writer permission binding receiver is invalid');
      const state = bindingStates.get(this);
      if (state === undefined) throw new TypeError('writer permission binding is foreign');
      return state.isMaintenanceWriterVeto();
    },
    bindWriterWake(this: unknown, wake: () => void): void {
      if ((typeof this !== 'object' && typeof this !== 'function') || this === null) throw new TypeError('writer permission binding receiver is invalid');
      const state = bindingStates.get(this);
      if (state === undefined) throw new TypeError('writer permission binding is foreign');
      state.bindWriterWake(wake);
    },
    bindMaintenanceReadySettlement(this: unknown, settle: () => void): void {
      if ((typeof this !== 'object' && typeof this !== 'function') || this === null) throw new TypeError('writer permission binding receiver is invalid');
      const state = bindingStates.get(this);
      if (state === undefined) throw new TypeError('writer permission binding is foreign');
      state.bindMaintenanceReadySettlement(settle);
    },
  });
  bindingStates.set(binding, Object.freeze({ control, acquire, canStartWriter, isMaintenanceWriterVeto, bindWriterWake, bindMaintenanceReadySettlement }));
  return binding;
}

export function assertG10aWriterPermissionBinding(
  value: unknown,
): asserts value is G10aWriterPermissionBinding {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || bindingStates.get(value) === undefined) {
    throw new TypeError('writer permission binding is not trusted');
  }
}
