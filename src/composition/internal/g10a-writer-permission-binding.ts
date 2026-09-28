import {
  assertRuntimeControl,
  type IssuedPersistenceLease,
  type RuntimeControl,
} from '../../runtime/internal/runtime-control.js';

/** Internal-only capability used by G07b at the exact G08 invocation seam. */
export interface G10aWriterPermissionBinding {
  acquireIssuedPersistence(): IssuedPersistenceLease;
}

interface BindingState {
  readonly control: RuntimeControl;
  readonly acquire: () => IssuedPersistenceLease;
}

const bindingStates = new WeakMap<object, BindingState>();

export function createG10aWriterPermissionBinding(value: unknown): G10aWriterPermissionBinding {
  assertRuntimeControl(value);
  const control = value as RuntimeControl;
  const acquire = control.acquireIssuedPersistence.bind(control);
  const binding = Object.freeze({
    acquireIssuedPersistence(this: unknown): IssuedPersistenceLease {
      if ((typeof this !== 'object' && typeof this !== 'function') || this === null) {
        throw new TypeError('writer permission binding receiver is invalid');
      }
      const state = bindingStates.get(this);
      if (state === undefined) throw new TypeError('writer permission binding is foreign');
      return state.acquire();
    },
  });
  bindingStates.set(binding, Object.freeze({ control, acquire }));
  return binding;
}

export function assertG10aWriterPermissionBinding(
  value: unknown,
): asserts value is G10aWriterPermissionBinding {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || bindingStates.get(value) === undefined) {
    throw new TypeError('writer permission binding is not trusted');
  }
}
