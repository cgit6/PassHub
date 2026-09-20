import type { AccessScopeContext, ResolvedIdentitySnapshot } from '../ports/index.js';

export type ResolutionMedia = 'QR' | 'FACE_MATCHED' | 'FACE_UNKNOWN';
export type ResolutionKind =
  | 'RESOLVED'
  | 'INVALID_QR_CREDENTIAL'
  | 'FACE_UNKNOWN'
  | 'FACE_SUBJECT_NOT_MAPPED'
  | 'SOURCE_INACTIVE';

export interface ResolutionHandle {
  readonly __opaqueResolutionHandle: unique symbol;
}

export interface ResolutionHandleClaims {
  readonly scopeToken: object;
  readonly context: AccessScopeContext;
  readonly epoch: string;
  readonly owner: string;
  readonly generation: string;
  readonly media: ResolutionMedia;
  readonly resolution: ResolutionKind;
  readonly qualificationId: string | null;
  readonly qualificationIncarnation: string | null;
  readonly qualificationVersion: number | null;
  readonly mappingIncarnation: string | null;
  readonly mappingVersion: number | null;
}

const claimsByHandle = new WeakMap<object, ResolutionHandleClaims>();

export function createResolutionHandle(
  claims: ResolutionHandleClaims,
): ResolutionHandle {
  // The object intentionally has no enumerable data. All authority lives in
  // this module's WeakMap and is checked against the live scope token.
  const handle = Object.freeze({}) as ResolutionHandle;
  claimsByHandle.set(handle, claims);
  return handle;
}

export function readResolutionHandleClaims(
  handle: unknown,
): ResolutionHandleClaims | null {
  if ((typeof handle !== 'object' && typeof handle !== 'function') || handle === null) {
    return null;
  }
  return claimsByHandle.get(handle) ?? null;
}

export function snapshotToHandleClaims(
  scopeToken: object,
  context: AccessScopeContext,
  epoch: string,
  owner: string,
  generation: string,
  media: ResolutionMedia,
  resolved: ResolvedIdentitySnapshot,
  resolutionOverride?: ResolutionKind,
): ResolutionHandleClaims {
  const qualification = resolved.qualification;
  const mapping = resolved.mapping;
  let resolution: ResolutionKind;
  if (resolutionOverride !== undefined) {
    resolution = resolutionOverride;
  } else if (qualification !== null) {
    resolution = 'RESOLVED';
  } else if (media === 'QR') {
    resolution = 'INVALID_QR_CREDENTIAL';
  } else if (media === 'FACE_UNKNOWN') {
    resolution = 'FACE_UNKNOWN';
  } else {
    resolution = 'FACE_SUBJECT_NOT_MAPPED';
  }
  return {
    scopeToken,
    context,
    epoch,
    owner,
    generation,
    media,
    resolution,
    qualificationId: qualification?.qualificationId ?? null,
    qualificationIncarnation: qualification?.incarnation ?? null,
    qualificationVersion: qualification?.version ?? null,
    mappingIncarnation: mapping?.mappingIncarnation ?? null,
    mappingVersion: mapping?.version ?? null,
  };
}
