import { randomUUID } from 'node:crypto';

import type { G04aFaceSlotDocument } from './g04a-face-index-schema.js';

export interface G04aFaceIndexFixture {
  readonly qualificationId: string;
  readonly qualificationIncarnation: string;
  readonly oldSlotId: string;
  readonly replacementSlotId: string;
  readonly oldProvider: string;
  readonly oldSubject: string;
  readonly replacementProvider: string;
  readonly replacementSubject: string;
  readonly slots: readonly G04aFaceSlotDocument[];
}

/**
 * Creates deterministic-shape data with one bound slot and two empty slots.
 * Empty slots retain their old subject key and have only their qualification
 * reference cleared; this is the slot lifecycle exercised by G04a.
 */
export function createG04aFaceIndexFixture(): G04aFaceIndexFixture {
  const qualificationId = randomUUID();
  const qualificationIncarnation = randomUUID();
  const oldSlotId = randomUUID();
  const replacementSlotId = randomUUID();
  const secondEmptySlotId = randomUUID();
  const oldProvider = 'fixture.provider';
  const oldSubject = 'fixture.subject.old';
  const replacementProvider = 'fixture.provider';
  const replacementSubject = 'fixture.subject.replacement';

  const slots: readonly G04aFaceSlotDocument[] = [
    {
      _id: oldSlotId,
      provider: oldProvider,
      subject: oldSubject,
      qualificationId,
      qualificationIncarnation,
      slotIncarnation: randomUUID(),
      version: 0,
    },
    {
      _id: replacementSlotId,
      provider: 'fixture.empty',
      subject: 'fixture.empty.one',
      qualificationId: null,
      qualificationIncarnation: null,
      slotIncarnation: randomUUID(),
      version: 0,
    },
    {
      _id: secondEmptySlotId,
      provider: 'fixture.empty',
      subject: 'fixture.empty.two',
      qualificationId: null,
      qualificationIncarnation: null,
      slotIncarnation: randomUUID(),
      version: 0,
    },
  ];

  return Object.freeze({
    qualificationId,
    qualificationIncarnation,
    oldSlotId,
    replacementSlotId,
    oldProvider,
    oldSubject,
    replacementProvider,
    replacementSubject,
    slots,
  });
}
