import type { ReasonCode } from '../domain/index.js';

export interface QueryAfterKey {
  readonly lastTimeMs: number;
  readonly lastId: string;
}

export interface QueryPage<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor: string | null;
}

export interface QualificationQueryItem {
  readonly qualificationId: string;
  readonly displayName: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly presence: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
  readonly expired: boolean;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly expiredTerminalAt: string | null;
  readonly faceBound: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EventQueryItem {
  readonly eventId: string;
  readonly sourceId: string;
  readonly direction: 'ENTRY' | 'EXIT';
  readonly kind: 'QR_SCANNED' | 'FACE_MATCHED' | 'FACE_UNKNOWN';
  readonly outcome: 'ACCEPTED' | 'REJECTED';
  readonly reasonCode: ReasonCode;
  readonly receivedAt: string;
  readonly recordedAt: string;
  readonly qualificationId: string | null;
  readonly presenceTransition: Readonly<{
    readonly from: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
    readonly to: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
  }> | null;
}

export interface EventQueryFilters {
  readonly qualificationId: string | null;
  readonly outcome: 'ACCEPTED' | 'REJECTED' | null;
  readonly reasonCode: ReasonCode | null;
}

export interface QualificationQueryInput {
  readonly fetchLimit: number;
  readonly after: QueryAfterKey | null;
}

export interface EventQueryInput extends QualificationQueryInput {
  readonly filters: EventQueryFilters;
}

export interface QuerySnapshotQualification {
  readonly qualificationId: string;
  readonly displayName: string;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly presence: 'NOT_ENTERED' | 'INSIDE' | 'EXITED';
  readonly enteredAtMs: number | null;
  readonly exitedAtMs: number | null;
  readonly revokedAtMs: number | null;
  readonly revocationReason: string | null;
  readonly expiredTerminalAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly qualificationIncarnation: string;
  readonly faceMapping: Readonly<{
    readonly qualificationId: string;
    readonly qualificationIncarnation: string;
    readonly mappingIncarnation: string;
    readonly version: number;
  }> | null;
}

export interface QuerySnapshotEvent {
  readonly eventId: string;
  readonly sourceId: string;
  readonly direction: 'ENTRY' | 'EXIT';
  readonly kind: 'QR_SCANNED' | 'FACE_MATCHED' | 'FACE_UNKNOWN';
  readonly outcome: 'ACCEPTED' | 'REJECTED';
  readonly reasonCode: ReasonCode;
  readonly receivedAtMs: number;
  readonly recordedAtMs: number;
  readonly qualificationId: string | null;
  readonly presenceTransition: EventQueryItem['presenceTransition'];
}

export interface QueryDataPort {
  listQualifications(
    input: QualificationQueryInput & Readonly<{ readonly observedAtMs: number }>,
  ): Promise<readonly QuerySnapshotQualification[]>;
  listInside(
    input: QualificationQueryInput & Readonly<{ readonly observedAtMs: number }>,
  ): Promise<readonly QuerySnapshotQualification[]>;
  listEvents(
    input: EventQueryInput & Readonly<{ readonly observedAtMs: number }>,
  ): Promise<readonly QuerySnapshotEvent[]>;
  readQualification(
    qualificationId: string,
    observedAtMs: number,
  ): Promise<QuerySnapshotQualification | null>;
  readEvent(
    eventId: string,
    observedAtMs: number,
  ): Promise<QuerySnapshotEvent | null>;
}

export type QueryDetailResult<TItem> =
  | Readonly<{ readonly kind: 'FOUND'; readonly item: TItem }>
  | Readonly<{ readonly kind: 'NOT_FOUND' }>;
