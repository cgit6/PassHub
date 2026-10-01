import {
  SourcePrincipal,
  type SourcePrincipalFacts,
} from '../../auth/domain/index.js';
import {
  isSourceAuthCapability,
  type SourceAuthCapability,
} from '../../auth/application/source-auth.js';
import type { RecognizeAttempt } from '../../access/application/use-cases.js';
import { RecognizeAttemptImplementation } from '../../access/application/use-cases.js';
import {
  RecognitionAccessScope,
  type FirstScopedPersistenceUse,
  type ScopeOptions,
} from '../../access/application/access-scopes.js';
import type {
  ComparisonPort,
} from '../../access/application/comparison/comparison-port.js';
import { isVerifiedComparisonPort } from '../../access/application/comparison/comparison-port.js';
import type {
  RecognitionDataPort,
  SourceFactsPort,
} from '../../access/ports/index.js';
import {
  isArtifactBoundRecognizeAttempt,
} from '../../access/application/internal/recognition-execution.js';
import type { AdmissionWorkContext } from './g07b-admission-handler.js';
import { createG10bFirstScopedPersistenceBinder } from './g10b-operation-bridge.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const bindings = new WeakMap<object, SourcePrincipalFacts>();
const executorFactories = new WeakMap<object, (binding: SourceBoundRecognitionBinding) => RecognizeAttempt>();
const executorScopeHooks = new WeakMap<object, FirstScopedPersistenceUse | null>();
const admissionBoundExecutors = new WeakSet<object>();

/** Opaque source provenance used only by the internal access composition. */
export interface SourceBoundRecognitionBinding {
  readonly __sourceBoundRecognitionBinding: unique symbol;
}

declare const sourceBoundExecutorFactoryBrand: unique symbol;

export interface SourceBoundRecognitionExecutorFactory {
  readonly [sourceBoundExecutorFactoryBrand]: never;
}

function issueSourceBoundRecognitionBinding(
  sourceAuth: SourceAuthCapability,
  principal: SourcePrincipal,
): SourceBoundRecognitionBinding {
  if (!isSourceAuthCapability(sourceAuth) || !(principal instanceof SourcePrincipal)) {
    throw new TypeError('verified Source principal facts are required');
  }
  const facts = sourceAuth.facts(principal);
  if (typeof facts !== 'object' || facts === null ||
      typeof facts.sourceId !== 'string' || !UUID_V4.test(facts.sourceId)) {
    throw new TypeError('verified Source principal facts are malformed');
  }
  const binding = Object.freeze({}) as SourceBoundRecognitionBinding;
  bindings.set(binding, Object.freeze({ sourceId: facts.sourceId }));
  return binding;
}

function readSourceBoundRecognitionBinding(
  binding: SourceBoundRecognitionBinding,
): SourcePrincipalFacts {
  const facts = bindings.get(binding as object);
  if (facts === undefined) throw new TypeError('source-bound recognition binding is invalid');
  return facts;
}

function issueSourceBoundRecognitionExecutorFactory(
  create: (binding: SourceBoundRecognitionBinding) => RecognizeAttempt,
): SourceBoundRecognitionExecutorFactory {
  if (typeof create !== 'function') throw new TypeError('recognition executor factory is required');
  const factory = Object.freeze({}) as SourceBoundRecognitionExecutorFactory;
  executorFactories.set(factory, create);
  return factory;
}

/**
 * Internal provenance gate.  This is intentionally not re-exported from the
 * internal barrel or package surface: only the source-bound composition may
 * use it to validate a factory supplied at construction time.
 */
export function assertSourceBoundRecognitionExecutorFactory(
  factory: SourceBoundRecognitionExecutorFactory,
): void {
  if (typeof factory !== 'object' || factory === null
    || !Object.isFrozen(factory) || Reflect.ownKeys(factory).length !== 0
    || !executorFactories.has(factory)) {
    throw new TypeError('recognition executor factory is foreign or forged');
  }
}

function createSourceBoundRecognitionExecutor(
  factory: SourceBoundRecognitionExecutorFactory,
  binding: SourceBoundRecognitionBinding,
): RecognizeAttempt {
  assertSourceBoundRecognitionExecutorFactory(factory);
  readSourceBoundRecognitionBinding(binding);
  const create = executorFactories.get(factory);
  if (create === undefined) throw new TypeError('recognition executor factory provenance is missing');
  const executor = create(binding);
  if (!isArtifactBoundRecognizeAttempt(executor)) {
    throw new TypeError('recognition executor lacks trusted artifact bridge');
  }
  return executor;
}

export function createSourceBoundRecognitionExecutorFactory(options: Readonly<{
  readonly recognition: RecognitionDataPort;
  readonly sourceFacts: SourceFactsPort;
  readonly epoch: string;
  readonly comparison: ComparisonPort;
}>): SourceBoundRecognitionExecutorFactory {
  if (typeof options !== 'object' || options === null
    || typeof options.recognition !== 'object' || options.recognition === null
    || typeof options.recognition.readQualification !== 'function'
    || typeof options.recognition.readMapping !== 'function'
    || typeof options.recognition.resolveQr !== 'function'
    || typeof options.recognition.resolveFace !== 'function'
    || typeof options.recognition.stageRecognitionResult !== 'function'
    || (options.recognition.discard !== undefined && typeof options.recognition.discard !== 'function')
    || typeof options.sourceFacts !== 'object' || options.sourceFacts === null
    || typeof options.sourceFacts.read !== 'function'
    || typeof options.epoch !== 'string' || options.epoch.length === 0
    || !isVerifiedComparisonPort(options.comparison)
    || !Object.isFrozen(options.comparison)
    || typeof options.comparison.artifact !== 'object'
    || options.comparison.artifact === null
    || !Object.isFrozen(options.comparison.artifact)) {
    throw new TypeError('invalid source-bound recognition executor options');
  }
  const recognition = options.recognition;
  const sourceFacts = options.sourceFacts;
  const epoch = options.epoch;
  const comparison = options.comparison;
  const recognitionAdapter: RecognitionDataPort = Object.freeze({
    readQualification: recognition.readQualification.bind(recognition),
    readMapping: recognition.readMapping.bind(recognition),
    resolveQr: recognition.resolveQr.bind(recognition),
    resolveFace: recognition.resolveFace.bind(recognition),
    stageRecognitionResult: recognition.stageRecognitionResult.bind(recognition),
    ...(recognition.discard === undefined ? {} : {
      discard: recognition.discard.bind(recognition),
    }),
  });
  const sourceFactsAdapter: SourceFactsPort = Object.freeze({
    read: sourceFacts.read.bind(sourceFacts),
  });
  const scopeOptions: ScopeOptions = Object.freeze({ epoch });
  return issueSourceBoundRecognitionExecutorFactory((binding) => {
    const sourceId = readSourceBoundRecognitionBinding(binding).sourceId;
    let executor!: RecognizeAttempt;
    executor = new RecognizeAttemptImplementation(
      () => new RecognitionAccessScope(
        recognitionAdapter,
        sourceFactsAdapter,
        sourceId,
        scopeOptions,
        executorScopeHooks.get(executor) ?? undefined,
      ),
      comparison,
    );
    executorScopeHooks.set(executor, null);
    return executor;
  });
}

export function createSourceBoundRecognitionExecutorForPrincipal(
  factory: SourceBoundRecognitionExecutorFactory,
  sourceAuth: SourceAuthCapability,
  principal: SourcePrincipal,
): RecognizeAttempt {
  if (!isSourceAuthCapability(sourceAuth) || !(principal instanceof SourcePrincipal)) {
    throw new TypeError('verified Source principal facts are required');
  }
  const binding = issueSourceBoundRecognitionBinding(sourceAuth, principal);
  return createSourceBoundRecognitionExecutor(factory, binding);
}

/**
 * Associates one G07 ORIGINAL context with the executor created for its one
 * validated recognition token.  The hook is consumed by the first real scope
 * port call, never by validation or ordinary read-only routes.
 */
export function bindG10bRecognitionExecutorToAdmission(
  executor: RecognizeAttempt,
  admission: AdmissionWorkContext,
): void {
  if (typeof executor !== 'object' || executor === null || !executorScopeHooks.has(executor)) {
    throw new TypeError('recognition executor is not source-bound');
  }
  if (admissionBoundExecutors.has(executor)) {
    throw new TypeError('recognition executor is already associated with an admission context');
  }
  executorScopeHooks.set(executor, createG10bFirstScopedPersistenceBinder(admission));
  admissionBoundExecutors.add(executor);
}
