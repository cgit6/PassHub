import { types as nodeTypes } from 'node:util';

import {
  readConsumedRunTicketForRuntime,
  type ConsumedRunTicket,
} from './g11b-run-ticket-intake.js';
import {
  readVerifiedDatasetForRuntime,
  type VerifiedDataset,
  type VerifiedDatasetVerifier,
} from './g11b-dataset-verification.js';
import { captureClosedMetadata } from './g11b-closed-metadata-capture.js';

const CLAIMER_MINT = Symbol('G11b persistent run claimer mint');
const CLAIM_MINT = Symbol('G11b claimed persistent run mint');
const reservedTickets = new WeakSet<ConsumedRunTicket>();

export type PersistentRunClaimStatus =
  | 'CLAIMED'
  | 'CLAIM_HELD'
  | 'EPOCH_MISMATCH'
  | 'METADATA_MISSING_OR_INVALID'
  | 'CLAIM_UNKNOWN';

export type PersistentRunClaimFailure =
  | 'PERSISTENT_RUN_CLAIM_INVALID'
  | 'RUN_TICKET_ALREADY_USED';

export class PersistentRunClaimError extends Error {
  constructor(readonly code: PersistentRunClaimFailure) {
    super(code);
    this.name = 'PersistentRunClaimError';
  }
}

export interface PersistentRunClaimRequest {
  readonly datasetEpoch: string;
  readonly processRunId: string;
}

export interface PersistentRunClaimIo {
  readonly compareAndSet: (request: PersistentRunClaimRequest) => Promise<unknown | null>;
  readonly classifyAfterNoMatch: () => Promise<unknown | null>;
}

export class ClaimedPersistentRun {
  declare private readonly nominalClaimedPersistentRun: void;

  constructor(authority: symbol) {
    if (authority !== CLAIM_MINT) throw new PersistentRunClaimError('PERSISTENT_RUN_CLAIM_INVALID');
    Object.freeze(this);
  }
}

export type PersistentRunClaimOutcome =
  | Readonly<{ readonly status: 'CLAIMED'; readonly claim: ClaimedPersistentRun }>
  | Readonly<{ readonly status: Exclude<PersistentRunClaimStatus, 'CLAIMED'> }>;

export interface ClaimedPersistentRunFacts {
  readonly datasetEpoch: string;
  readonly processRunId: string;
  readonly ticketId: string;
  readonly claimedAtMillis: number;
}

export class PersistentRunClaimer {
  declare private readonly nominalPersistentRunClaimer: void;

  constructor(authority: symbol) {
    if (authority !== CLAIMER_MINT) throw new PersistentRunClaimError('PERSISTENT_RUN_CLAIM_INVALID');
    Object.freeze(this);
  }

  async claimOnce(verified: VerifiedDataset, ticket: ConsumedRunTicket): Promise<PersistentRunClaimOutcome> {
    const state = claimerStates.get(this);
    if (state === undefined) throw new PersistentRunClaimError('PERSISTENT_RUN_CLAIM_INVALID');

    let ticketFacts: ReturnType<typeof readConsumedRunTicketForRuntime>;
    try {
      ticketFacts = readConsumedRunTicketForRuntime(ticket);
    } catch {
      throw new PersistentRunClaimError('PERSISTENT_RUN_CLAIM_INVALID');
    }
    if (reservedTickets.has(ticket)) throw new PersistentRunClaimError('RUN_TICKET_ALREADY_USED');
    reservedTickets.add(ticket);

    let verifiedFacts: ReturnType<typeof readVerifiedDatasetForRuntime>;
    try {
      verifiedFacts = readVerifiedDatasetForRuntime(state.verifier, verified, state.target);
    } catch {
      throw new PersistentRunClaimError('PERSISTENT_RUN_CLAIM_INVALID');
    }
    if (verifiedFacts.datasetEpoch !== ticketFacts.datasetEpoch) return status('EPOCH_MISMATCH');

    const request = Object.freeze({
      datasetEpoch: ticketFacts.datasetEpoch,
      processRunId: ticketFacts.processRunId,
    });
    let postimage: unknown | null;
    try {
      postimage = await state.io.compareAndSet(request);
    } catch {
      return status('CLAIM_UNKNOWN');
    }
    if (postimage === null) return classifyNoMatch(state, request);

    let metadata: ReturnType<typeof captureClosedMetadata>;
    try {
      metadata = captureClosedMetadata(postimage);
    } catch {
      return status('CLAIM_UNKNOWN');
    }
    if (metadata.datasetEpoch !== ticketFacts.datasetEpoch || metadata.writeRunClaim === null
      || metadata.writeRunClaim.runId !== ticketFacts.processRunId) return status('CLAIM_UNKNOWN');

    const claim = new ClaimedPersistentRun(CLAIM_MINT);
    claimedStates.set(claim, Object.freeze({
      claimer: this,
      target: state.target,
      verifier: state.verifier,
      verified,
      ticket,
      facts: Object.freeze({
        datasetEpoch: ticketFacts.datasetEpoch,
        processRunId: ticketFacts.processRunId,
        ticketId: ticketFacts.ticketId,
        claimedAtMillis: metadata.writeRunClaim.claimedAtMillis,
      }),
    }));
    return Object.freeze({ status: 'CLAIMED', claim });
  }
}

interface ClaimerState {
  readonly target: object;
  readonly verifier: VerifiedDatasetVerifier;
  readonly io: PersistentRunClaimIo;
}

interface ClaimedState {
  readonly claimer: PersistentRunClaimer;
  readonly target: object;
  readonly verifier: VerifiedDatasetVerifier;
  readonly verified: VerifiedDataset;
  readonly ticket: ConsumedRunTicket;
  readonly facts: ClaimedPersistentRunFacts;
}

const claimerStates = new WeakMap<PersistentRunClaimer, ClaimerState>();
const claimedStates = new WeakMap<ClaimedPersistentRun, ClaimedState>();

/** Shared private engine factory; injection is exposed only through test support in b3a. */
export function createPersistentRunClaimerWithIo(
  target: object,
  verifier: VerifiedDatasetVerifier,
  io: PersistentRunClaimIo,
): PersistentRunClaimer {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) invalid();
  const capturedIo = captureIo(io);
  const claimer = new PersistentRunClaimer(CLAIMER_MINT);
  claimerStates.set(claimer, Object.freeze({ target, verifier, io: capturedIo }));
  return claimer;
}

/** Private future bridge reader. This slice deliberately mints no write capability. */
export function readClaimedPersistentRunForBridge(
  claimer: PersistentRunClaimer,
  claim: ClaimedPersistentRun,
  target: object,
  verifier: VerifiedDatasetVerifier,
  verified: VerifiedDataset,
  ticket: ConsumedRunTicket,
): ClaimedPersistentRunFacts {
  const state = claimedStates.get(claim);
  if (state === undefined || state.claimer !== claimer || state.target !== target
    || state.verifier !== verifier || state.verified !== verified || state.ticket !== ticket) invalid();
  return Object.freeze({ ...state.facts });
}

async function classifyNoMatch(
  state: ClaimerState,
  request: PersistentRunClaimRequest,
): Promise<PersistentRunClaimOutcome> {
  let observed: unknown | null;
  try {
    observed = await state.io.classifyAfterNoMatch();
  } catch {
    return status('CLAIM_UNKNOWN');
  }
  if (observed === null) return status('METADATA_MISSING_OR_INVALID');
  let metadata: ReturnType<typeof captureClosedMetadata>;
  try {
    metadata = captureClosedMetadata(observed);
  } catch {
    return status('METADATA_MISSING_OR_INVALID');
  }
  if (metadata.datasetEpoch !== request.datasetEpoch) return status('EPOCH_MISMATCH');
  if (metadata.writeRunClaim !== null) return status('CLAIM_HELD');
  return status('CLAIM_UNKNOWN');
}

function captureIo(input: unknown): PersistentRunClaimIo {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || nodeTypes.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes('compareAndSet') || !keys.includes('classifyAfterNoMatch')) invalid();
  const cas = Object.getOwnPropertyDescriptor(input, 'compareAndSet');
  const classify = Object.getOwnPropertyDescriptor(input, 'classifyAfterNoMatch');
  if (cas === undefined || classify === undefined || !cas.enumerable || !classify.enumerable
    || !Object.hasOwn(cas, 'value') || !Object.hasOwn(classify, 'value')
    || typeof cas.value !== 'function' || typeof classify.value !== 'function') invalid();
  return Object.freeze({
    compareAndSet: cas.value as PersistentRunClaimIo['compareAndSet'],
    classifyAfterNoMatch: classify.value as PersistentRunClaimIo['classifyAfterNoMatch'],
  });
}

function status(value: Exclude<PersistentRunClaimStatus, 'CLAIMED'>): PersistentRunClaimOutcome {
  return Object.freeze({ status: value });
}

function invalid(): never {
  throw new PersistentRunClaimError('PERSISTENT_RUN_CLAIM_INVALID');
}
