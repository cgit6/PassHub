import type { AcceptedIngressHandler } from '../../shared/internal/http/index.js';
import {
  createPassHubHttpApplication,
  type PassHubHttpApplication,
} from './http-application.js';
import {
  assertG10aRuntimeOwner,
  type G10aRuntimeCapabilities,
  type G10aRuntimeOwner,
} from './g10a-runtime-owner.js';

/**
 * Private lifecycle root: runtime startup completes before HTTP can listen,
 * and shutdown closes HTTP intake before it closes the owner socket/log sink.
 * It intentionally receives a handler factory instead of publishing runtime
 * capabilities to the application surface.
 */
export interface G10aRuntimeHttpApplicationOptions {
  readonly runtimeOwner: G10aRuntimeOwner;
  readonly createAcceptedHandler: (runtime: G10aRuntimeCapabilities) => AcceptedIngressHandler;
}

export interface G10aRuntimeHttpApplication {
  readonly application: PassHubHttpApplication;
  close(): Promise<void>;
}

const applicationProvenance = new WeakMap<G10aRuntimeHttpApplication, Readonly<{
  runtime: G10aRuntimeCapabilities;
  handler: AcceptedIngressHandler;
  isClosing: () => boolean;
}>>();

/** Private inspection never accepts an assembled structural application. */
export function readG10aRuntimeHttpApplicationProvenance(application: G10aRuntimeHttpApplication) {
  const facts = applicationProvenance.get(application);
  if (facts === undefined) throw new TypeError('G10a runtime HTTP application is not trusted');
  return facts;
}

export async function createG10aRuntimeHttpApplication(
  input: G10aRuntimeHttpApplicationOptions,
): Promise<G10aRuntimeHttpApplication> {
  const options = captureOptions(input);
  const runtime = await options.runtimeOwner.start();
  let application: PassHubHttpApplication;
  let handler: AcceptedIngressHandler;
  try {
    handler = options.createAcceptedHandler(runtime);
    if (typeof handler !== 'function') throw new TypeError('G10a accepted handler factory returned invalid handler');
    application = await createPassHubHttpApplication(handler);
  } catch (error) {
    await options.runtimeOwner.close().catch(() => undefined);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  let nestClosing = false;
  let serverClosing = false;
  const originalNestApplication = application.nestApplication;
  const closeNestApplication = originalNestApplication.close.bind(originalNestApplication);
  // Nest's own Proxy ignores ordinary property assignments. Retain a private
  // outer handle that observes close before delegating to the original Proxy.
  const observedClose = (...args: Parameters<typeof closeNestApplication>) => {
    nestClosing = true;
    return closeNestApplication(...args);
  };
  application = Object.freeze({
    ...application,
    nestApplication: new Proxy(originalNestApplication, {
      get: (target, property) => property === 'close' ? observedClose : Reflect.get(target, property, target),
    }),
  });
  const closeHttpServer = application.server.close.bind(application.server);
  application.server.close = (...args: Parameters<typeof closeHttpServer>) => {
    serverClosing = true;
    return closeHttpServer(...args);
  };
  const composed = Object.freeze({
    application,
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async (): Promise<void> => {
        let primary: unknown;
        try {
          await application.nestApplication.close();
        } catch (error) {
          primary = error;
        }
        try {
          await options.runtimeOwner.close();
        } catch (error) {
          if (primary === undefined) primary = error;
        }
        if (primary !== undefined) throw primary;
      })();
      return closePromise;
    },
  });
  applicationProvenance.set(composed, Object.freeze({
    runtime, handler, isClosing: () => serverClosing || nestClosing || closePromise !== undefined,
  }));
  return composed;
}

function captureOptions(input: unknown): Readonly<G10aRuntimeHttpApplicationOptions> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('G10a runtime HTTP application options are invalid');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes('runtimeOwner') || !keys.includes('createAcceptedHandler')
    || keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('G10a runtime HTTP application options are invalid');
  }
  const record = input as Record<string, unknown>;
  const ownerDescriptor = Object.getOwnPropertyDescriptor(record, 'runtimeOwner');
  const handlerDescriptor = Object.getOwnPropertyDescriptor(record, 'createAcceptedHandler');
  if (ownerDescriptor === undefined || handlerDescriptor === undefined
    || !ownerDescriptor.enumerable || !handlerDescriptor.enumerable
    || !Object.hasOwn(ownerDescriptor, 'value') || !Object.hasOwn(handlerDescriptor, 'value')
    || typeof handlerDescriptor.value !== 'function') {
    throw new TypeError('G10a runtime HTTP application options are invalid');
  }
  assertG10aRuntimeOwner(ownerDescriptor.value);
  return Object.freeze({
    runtimeOwner: ownerDescriptor.value,
    createAcceptedHandler: handlerDescriptor.value as (runtime: G10aRuntimeCapabilities) => AcceptedIngressHandler,
  });
}
