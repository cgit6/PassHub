import {
  DomainInvariantError,
  assertQualificationState,
  decideQualificationExpiration,
  decideQualificationRevocation,
  decideQualificationUpdate,
  decideQualificationWindow,
  qualificationCanRetainFaceMapping,
  type QualificationState,
} from '../../src/access/domain/qualification.js';

function qualification(
  overrides: Partial<QualificationState> = {},
): QualificationState {
  return {
    validFromMs: 1_000,
    validUntilMs: 2_000,
    presence: 'NOT_ENTERED',
    enteredAtMs: null,
    exitedAtMs: null,
    revokedAtMs: null,
    revocationReason: null,
    expiredTerminalAtMs: null,
    ...overrides,
  };
}

test('creation and update windows allow past, present, future, cross-day, and long visits', () => {
  const receivedAtMs = 1_000;
  for (const [validFromMs, validUntilMs] of [
    [0, 2_000],
    [1_000, 2_000],
    [1_500, 2_000],
    [1_500, 100_000_000],
  ] as const) {
    expect(
      decideQualificationWindow({
        validFromMs,
        validUntilMs,
        receivedAtMs,
      }),
    ).toEqual({ allowed: true });
  }
});

test('qualification windows reject equal, reversed, and already-ended ranges', () => {
  expect(
    decideQualificationWindow({
      validFromMs: 1_000,
      validUntilMs: 1_000,
      receivedAtMs: 500,
    }),
  ).toEqual({
      allowed: false,
      reason: 'VALID_UNTIL_NOT_AFTER_VALID_FROM',
    });
  expect(
    decideQualificationWindow({
      validFromMs: 2_000,
      validUntilMs: 1_000,
      receivedAtMs: 500,
    }),
  ).toEqual({
      allowed: false,
      reason: 'VALID_UNTIL_NOT_AFTER_VALID_FROM',
    });
  expect(
    decideQualificationWindow({
      validFromMs: 0,
      validUntilMs: 1_000,
      receivedAtMs: 1_000,
    }),
  ).toEqual({
      allowed: false,
      reason: 'VALID_UNTIL_NOT_AFTER_RECEIVED_AT',
    });
});

test('only an active NOT_ENTERED qualification can be updated and QR is preserved', () => {
  expect(
    decideQualificationUpdate({
      qualification: qualification(),
      proposedValidFromMs: 1_500,
      proposedValidUntilMs: 3_000,
      receivedAtMs: 1_500,
    }),
  ).toEqual({ allowed: true, preserveQrCredential: true });

  const cases: ReadonlyArray<
    readonly [Partial<QualificationState>, number, string]
  > = [
    [
      { presence: 'INSIDE', enteredAtMs: 1_500 },
      1_600,
      'QUALIFICATION_ALREADY_ENTERED',
    ],
    [
      { presence: 'EXITED', enteredAtMs: 1_500, exitedAtMs: 1_600 },
      1_700,
      'QUALIFICATION_ALREADY_USED',
    ],
    [
      { revokedAtMs: 1_500, revocationReason: 'cancelled' },
      1_600,
      'QUALIFICATION_ALREADY_REVOKED',
    ],
    [
      { expiredTerminalAtMs: 2_000 },
      2_100,
      'QUALIFICATION_ALREADY_EXPIRED',
    ],
    [{}, 2_000, 'QUALIFICATION_ALREADY_EXPIRED'],
  ];

  for (const [overrides, receivedAtMs, reason] of cases) {
    expect(
      decideQualificationUpdate({
        qualification: qualification(overrides),
        proposedValidFromMs: 1_500,
        proposedValidUntilMs: 3_000,
        receivedAtMs,
      }),
    ).toEqual({ allowed: false, reason });
  }
});

test('updates revalidate the final proposed window', () => {
  expect(
    decideQualificationUpdate({
      qualification: qualification(),
      proposedValidFromMs: 1_500,
      proposedValidUntilMs: 1_500,
      receivedAtMs: 1_200,
    }),
  ).toEqual({
      allowed: false,
      reason: 'VALID_UNTIL_NOT_AFTER_VALID_FROM',
    });
});

test('revocation requires a reason and returns the complete face release effect', () => {
  expect(
    decideQualificationRevocation({
      qualification: qualification(),
      receivedAtMs: 1_500,
      reason: null,
    }),
  ).toEqual({ allowed: false, reason: 'REVOCATION_REASON_REQUIRED' });
  expect(
    decideQualificationRevocation({
      qualification: qualification(),
      receivedAtMs: 1_500,
      reason: 'cancelled',
    }),
  ).toEqual({ allowed: true, releaseFaceMapping: true });
});

test('expiration is lazy, terminalizes only eligible NOT_ENTERED, and releases face', () => {
  expect(
    decideQualificationExpiration({
      qualification: qualification(),
      receivedAtMs: 1_999,
    }),
  ).toEqual({ terminalize: false, releaseFaceMapping: false });
  expect(
    decideQualificationExpiration({
      qualification: qualification(),
      receivedAtMs: 2_000,
    }),
  ).toEqual({ terminalize: true, releaseFaceMapping: true });
  expect(
    decideQualificationExpiration({
      qualification: qualification({
        presence: 'INSIDE',
        enteredAtMs: 1_500,
      }),
      receivedAtMs: 9_000,
    }),
  ).toEqual({ terminalize: false, releaseFaceMapping: false });
});

test('face mapping is inactive after NOT_ENTERED expiry but retained for overdue INSIDE', () => {
  expect(
    qualificationCanRetainFaceMapping(qualification(), 1_999),
  ).toBe(true);
  expect(
    qualificationCanRetainFaceMapping(qualification(), 2_000),
  ).toBe(false);
  expect(
    qualificationCanRetainFaceMapping(
      qualification({ presence: 'INSIDE', enteredAtMs: 1_500 }),
      9_000,
    ),
  ).toBe(true);
  expect(
    qualificationCanRetainFaceMapping(
      qualification({
        revokedAtMs: 1_500,
        revocationReason: 'cancelled',
      }),
      1_600,
    ),
  ).toBe(false);
  expect(
    qualificationCanRetainFaceMapping(
      qualification({ expiredTerminalAtMs: 2_000 }),
      2_100,
    ),
  ).toBe(false);
  expect(
    qualificationCanRetainFaceMapping(
      qualification({
        presence: 'EXITED',
        enteredAtMs: 1_500,
        exitedAtMs: 1_600,
      }),
      1_700,
    ),
  ).toBe(false);
});

test('corrupt qualification combinations are technical invariant errors', () => {
  const invalidStates: QualificationState[] = [
    qualification({ enteredAtMs: 1_500 }),
    qualification({ revokedAtMs: 1_500 }),
    qualification({
      revokedAtMs: 1_500,
      revocationReason: 'cancelled',
      expiredTerminalAtMs: 2_000,
    }),
    qualification({ presence: 'INSIDE', enteredAtMs: null }),
    qualification({
      presence: 'EXITED',
      enteredAtMs: 1_500,
      exitedAtMs: null,
    }),
  ];

  for (const state of invalidStates) {
    expect(() => assertQualificationState(state)).toThrow(DomainInvariantError);
  }
});

test('runtime-corrupted qualification fields fail with custom invariant errors', () => {
  const invalidStates: unknown[] = [
    qualification({ presence: 'UNKNOWN' } as unknown as Partial<QualificationState>),
    qualification({ revocationReason: 42 } as unknown as Partial<QualificationState>),
  ];

  for (const state of invalidStates) {
    expect(() => assertQualificationState(state as QualificationState)).toThrow(
      DomainInvariantError,
    );
  }

  expect(() =>
    decideQualificationRevocation({
      qualification: qualification(),
      receivedAtMs: 1_500,
      reason: 42 as unknown as string,
    }),
  ).toThrow(DomainInvariantError);
});
