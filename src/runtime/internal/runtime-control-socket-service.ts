import { types as nodeTypes } from 'node:util';

import {
  dispatchRuntimeControlProtocol,
  dispatchRuntimeControlProtocolSynchronously,
  type RuntimeControlProtocolFrame,
  type RuntimeControlProtocolResponse,
  type RuntimeControlProtocolSynchronousDispatch,
} from './runtime-control-protocol.js';
import {
  createRuntimeControlSocketFramingAdapter,
  type RuntimeControlSocketFrameDispatcher,
} from './runtime-control-socket-framing.js';
import {
  createRuntimeControlSocketListener,
  type RuntimeControlSocketListener,
} from './runtime-control-socket-listener.js';
import {
  assertRuntimeControl,
  type RuntimeControl,
} from './runtime-control.js';

/**
 * Internal composition boundary for the private AF_UNIX control plane.
 *
 * The three lower-level pieces remain deliberately independent: listener
 * owns pathname/lifecycle, framing owns bytes/connections, and protocol owns
 * DTO/replay/state dispatch.  This service is the only place that binds an
 * already-proven RuntimeControl to all three and gives a DRAIN observation an
 * abortable processing deadline.  It is intentionally not re-exported.
 */
export interface RuntimeControlSocketService {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface RuntimeControlSocketServiceOptions {
  readonly control: RuntimeControl;
  readonly directory: string;
  readonly socketPath: string;
}

export async function createRuntimeControlSocketService(
  input: RuntimeControlSocketServiceOptions,
): Promise<RuntimeControlSocketService> {
  const options = captureOptions(input);
  const dispatcher = createWatchdogDispatcher(options.control);
  const adapter = createRuntimeControlSocketFramingAdapter(options.control, dispatcher);
  const listener = await createRuntimeControlSocketListener({
    directory: options.directory,
    socketPath: options.socketPath,
    onConnection: adapter.onConnection,
  });
  return new PrivateRuntimeControlSocketService(listener);
}

class PrivateRuntimeControlSocketService implements RuntimeControlSocketService {
  readonly socketPath: string;

  constructor(private readonly listener: RuntimeControlSocketListener) {
    this.socketPath = listener.socketPath;
    Object.freeze(this);
  }

  close(): Promise<void> {
    return this.listener.close();
  }
}

function createWatchdogDispatcher(control: RuntimeControl): RuntimeControlSocketFrameDispatcher {
  return Object.freeze({
    async dispatch(frame: RuntimeControlProtocolFrame): Promise<RuntimeControlProtocolResponse | undefined> {
      // D186 makes these a real boundary rather than a comment: parse and
      // execute STATUS/HOLD/RELEASE through an API that cannot accept a
      // signal, callback, or Promise.  A valid DRAIN is the sole marker that
      // crosses into the async/watchdog path.
      const synchronous = dispatchRuntimeControlProtocolSynchronously(control, frame);
      if (!isDrainPending(synchronous)) return synchronous;
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), synchronous.timeoutMs + 1_000);
      try {
        // DRAIN receives the signal and converts an elapsed post-mutation
        // observation into a cached, non-rollback INTERNAL_UNAVAILABLE
        // terminal in RuntimeControl itself.
        return await dispatchRuntimeControlProtocol(control, frame, {
          signal: abortController.signal,
          abortOutcome: 'INTERNAL_UNAVAILABLE',
        });
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

function isDrainPending(value: RuntimeControlProtocolSynchronousDispatch): value is Extract<RuntimeControlProtocolSynchronousDispatch, { readonly kind: 'DRAIN_PENDING' }> {
  return value !== undefined && typeof value === 'object' && Object.hasOwn(value, 'kind')
    && (value as { readonly kind?: unknown }).kind === 'DRAIN_PENDING';
}

function captureOptions(input: unknown): Readonly<RuntimeControlSocketServiceOptions> {
  if (nodeTypes.isProxy(input) || typeof input !== 'object' || input === null
    || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError('runtime control socket service options are invalid');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 3 || !keys.includes('control') || !keys.includes('directory') || !keys.includes('socketPath')) {
    throw new TypeError('runtime control socket service options are invalid');
  }
  const control = Object.getOwnPropertyDescriptor(input, 'control');
  const directory = Object.getOwnPropertyDescriptor(input, 'directory');
  const socketPath = Object.getOwnPropertyDescriptor(input, 'socketPath');
  if (control === undefined || directory === undefined || socketPath === undefined
    || !control.enumerable || !directory.enumerable || !socketPath.enumerable
    || !Object.hasOwn(control, 'value') || !Object.hasOwn(directory, 'value') || !Object.hasOwn(socketPath, 'value')
    || typeof directory.value !== 'string' || typeof socketPath.value !== 'string') {
    throw new TypeError('runtime control socket service options are invalid');
  }
  assertRuntimeControl(control.value);
  return Object.freeze({
    control: control.value,
    directory: directory.value,
    socketPath: socketPath.value,
  });
}
