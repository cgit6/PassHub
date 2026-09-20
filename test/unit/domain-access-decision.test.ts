import {
  decideAccess,
  type AccessDecision,
  type IdentityResolution,
} from '../../src/access/domain/access-decision.js';
import {
  DomainInvariantError,
  type QualificationState,
} from '../../src/access/domain/qualification.js';

const VALID_FROM = 1_000;
const VALID_UNTIL = 2_000;

function qualification(
  overrides: Partial<QualificationState> = {},
): QualificationState {
  return {
    validFromMs: VALID_FROM,
    validUntilMs: VALID_UNTIL,
    presence: 'NOT_ENTERED',
    enteredAtMs: null,
    exitedAtMs: null,
    revokedAtMs: null,
    revocationReason: null,
    expiredTerminalAtMs: null,
    ...overrides,
  };
}

function resolved(
  overrides: Partial<QualificationState> = {},
): IdentityResolution {
  return { kind: 'RESOLVED', qualification: qualification(overrides) };
}

function reject(reasonCode: AccessDecision['reasonCode']): AccessDecision {
  return {
    outcome: 'REJECTED',
    reasonCode,
    presenceTransition: null,
    qualificationEffect: 'NONE',
    faceMappingEffect: 'KEEP',
  };
}

test('ENTRY applies every fixed reason and success at the half-open boundaries', () => {
  const cases: ReadonlyArray<
    readonly [string, Parameters<typeof decideAccess>[0], AccessDecision]
  > = [
    [
      'inactive source wins over an invalid credential',
      {
        direction: 'ENTRY',
        sourceActive: false,
        resolution: { kind: 'INVALID_QR_CREDENTIAL' },
        receivedAtMs: VALID_FROM,
      },
      reject('SOURCE_INACTIVE'),
    ],
    [
      'invalid QR',
      {
        direction: 'ENTRY',
        sourceActive: true,
        resolution: { kind: 'INVALID_QR_CREDENTIAL' },
        receivedAtMs: VALID_FROM,
      },
      reject('INVALID_QR_CREDENTIAL'),
    ],
    [
      'unknown face',
      {
        direction: 'ENTRY',
        sourceActive: true,
        resolution: { kind: 'FACE_UNKNOWN' },
        receivedAtMs: VALID_FROM,
      },
      reject('FACE_UNKNOWN'),
    ],
    [
      'unmapped face',
      {
        direction: 'ENTRY',
        sourceActive: true,
        resolution: { kind: 'FACE_SUBJECT_NOT_MAPPED' },
        receivedAtMs: VALID_FROM,
      },
      reject('FACE_SUBJECT_NOT_MAPPED'),
    ],
    [
      'revoked wins over expiration by time',
      {
        direction: 'ENTRY',
        sourceActive: true,
        resolution: resolved({
          revokedAtMs: 1_500,
          revocationReason: 'cancelled',
        }),
        receivedAtMs: VALID_UNTIL,
      },
      reject('QUALIFICATION_REVOKED'),
    ],
    [
      'inside wins over expiration by time',
      {
        direction: 'ENTRY',
        sourceActive: true,
        resolution: resolved({
          presence: 'INSIDE',
          enteredAtMs: 1_500,
        }),
        receivedAtMs: VALID_UNTIL,
      },
      reject('ALREADY_INSIDE'),
    ],
    [
      'exited wins over an early received time',
      {
        direction: 'ENTRY',
        sourceActive: true,
        resolution: resolved({
          presence: 'EXITED',
          enteredAtMs: 1_500,
          exitedAtMs: 1_600,
        }),
        receivedAtMs: VALID_FROM - 1,
      },
      reject('QUALIFICATION_ALREADY_USED'),
    ],
    [
      'before validFrom is too early',
      {
        direction: 'ENTRY',
        sourceActive: true,
        resolution: resolved(),
        receivedAtMs: VALID_FROM - 1,
      },
      reject('QUALIFICATION_NOT_YET_VALID'),
    ],
    [
      'exactly validUntil expires and requests terminalization',
      {
        direction: 'ENTRY',
        sourceActive: true,
        resolution: resolved(),
        receivedAtMs: VALID_UNTIL,
      },
      {
        outcome: 'REJECTED',
        reasonCode: 'QUALIFICATION_EXPIRED',
        presenceTransition: null,
        qualificationEffect: 'EXPIRE_NOT_ENTERED',
        faceMappingEffect: 'RELEASE',
      },
    ],
    [
      'exactly validFrom grants entry',
      {
        direction: 'ENTRY',
        sourceActive: true,
        resolution: resolved(),
        receivedAtMs: VALID_FROM,
      },
      {
        outcome: 'ACCEPTED',
        reasonCode: 'ENTRY_GRANTED',
        presenceTransition: { from: 'NOT_ENTERED', to: 'INSIDE' },
        qualificationEffect: 'NONE',
        faceMappingEffect: 'KEEP',
      },
    ],
  ];

  for (const [, input, expected] of cases) {
    expect(decideAccess(input)).toEqual(expected);
  }
});

test('an already terminalized expiration is rejected without repeating effects', () => {
  expect(
    decideAccess({
      direction: 'ENTRY',
      sourceActive: true,
      resolution: resolved({ expiredTerminalAtMs: 2_100 }),
      receivedAtMs: 1_500,
    }),
  ).toEqual(reject('QUALIFICATION_EXPIRED'));
});

test('EXIT ignores validity and revocation time checks but follows fixed state order', () => {
  const cases: ReadonlyArray<
    readonly [string, Parameters<typeof decideAccess>[0], AccessDecision]
  > = [
    [
      'inactive source wins first',
      {
        direction: 'EXIT',
        sourceActive: false,
        resolution: { kind: 'FACE_UNKNOWN' },
        receivedAtMs: 9_000,
      },
      reject('SOURCE_INACTIVE'),
    ],
    [
      'mapping failure wins before qualification state',
      {
        direction: 'EXIT',
        sourceActive: true,
        resolution: { kind: 'FACE_SUBJECT_NOT_MAPPED' },
        receivedAtMs: 9_000,
      },
      reject('FACE_SUBJECT_NOT_MAPPED'),
    ],
    [
      'revoked but never entered is not inside',
      {
        direction: 'EXIT',
        sourceActive: true,
        resolution: resolved({
          revokedAtMs: 1_500,
          revocationReason: 'cancelled',
        }),
        receivedAtMs: 9_000,
      },
      reject('NOT_INSIDE'),
    ],
    [
      'already exited',
      {
        direction: 'EXIT',
        sourceActive: true,
        resolution: resolved({
          presence: 'EXITED',
          enteredAtMs: 1_500,
          exitedAtMs: 1_600,
        }),
        receivedAtMs: 9_000,
      },
      reject('ALREADY_EXITED'),
    ],
    [
      'inside exits after validUntil and releases face mapping',
      {
        direction: 'EXIT',
        sourceActive: true,
        resolution: resolved({
          presence: 'INSIDE',
          enteredAtMs: 1_500,
        }),
        receivedAtMs: 9_000,
      },
      {
        outcome: 'ACCEPTED',
        reasonCode: 'EXIT_RECORDED',
        presenceTransition: { from: 'INSIDE', to: 'EXITED' },
        qualificationEffect: 'NONE',
        faceMappingEffect: 'RELEASE',
      },
    ],
  ];

  for (const [, input, expected] of cases) {
    expect(decideAccess(input)).toEqual(expected);
  }
});

test('every decision has exactly one outcome and one reason code', () => {
  const result = decideAccess({
    direction: 'ENTRY',
    sourceActive: true,
    resolution: resolved(),
    receivedAtMs: VALID_FROM,
  });

  expect(Object.keys(result).sort()).toEqual([
    'faceMappingEffect',
    'outcome',
    'presenceTransition',
    'qualificationEffect',
    'reasonCode',
  ]);
});

test('runtime-corrupted access inputs fail with custom domain invariants', () => {
  const cases: unknown[] = [
    {
      direction: 'ENTRY',
      sourceActive: true,
      resolution: resolved({ presence: 'UNKNOWN' } as unknown as Partial<QualificationState>),
      receivedAtMs: VALID_FROM,
    },
    {
      direction: 'SIDEWAYS',
      sourceActive: true,
      resolution: resolved(),
      receivedAtMs: VALID_FROM,
    },
    {
      direction: 'ENTRY',
      sourceActive: true,
      resolution: { kind: 'UNKNOWN' },
      receivedAtMs: VALID_FROM,
    },
    {
      direction: 'ENTRY',
      sourceActive: 'yes',
      resolution: resolved(),
      receivedAtMs: VALID_FROM,
    },
  ];

  for (const input of cases) {
    expect(() => decideAccess(input as Parameters<typeof decideAccess>[0])).toThrow(
      DomainInvariantError,
    );
  }
});
