import type {
  ManagementChangeResult,
  ManagementPublicChangeResult,
} from '../ports/index.js';

/**
 * Internal-only boundary for a future HTTP/application presenter.
 * Legacy persistence fields are deliberately discarded here.
 */
export function toManagementPublicChangeResult(
  result: ManagementChangeResult,
): ManagementPublicChangeResult {
  const summary = {
    qualificationId: result.summary.qualificationId,
    displayName: result.summary.displayName,
    validFromMs: result.summary.validFromMs,
    validUntilMs: result.summary.validUntilMs,
    presence: result.summary.presence,
    revokedAtMs: requiredSummaryField(result.summary.revokedAtMs, 'revokedAtMs'),
    revocationReason: requiredSummaryField(result.summary.revocationReason, 'revocationReason'),
    expiredTerminalAtMs: requiredSummaryField(result.summary.expiredTerminalAtMs, 'expiredTerminalAtMs'),
    faceBound: requiredSummaryField(result.summary.faceBound, 'faceBound'),
    createdAtMs: requiredSummaryField(result.summary.createdAtMs, 'createdAtMs'),
    updatedAtMs: requiredSummaryField(result.summary.updatedAtMs, 'updatedAtMs'),
  };
  if (result.operation === 'CREATE') {
    if (result.qrToken === null) throw new TypeError('create management result is missing qrToken');
    return { operation: 'CREATE', qualificationId: result.qualificationId, summary, qrToken: result.qrToken };
  }
  if (result.operation === 'EXPIRE') throw new TypeError('internal expiry result is not a public management result');
  return { operation: result.operation, qualificationId: result.qualificationId, summary };
}

function requiredSummaryField<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new TypeError(`management summary is missing ${field}`);
  return value;
}
