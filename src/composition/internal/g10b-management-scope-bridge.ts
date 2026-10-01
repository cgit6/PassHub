import type {
  FirstScopedPersistenceUse,
  ManagementScope,
} from '../../access/application/access-scopes.js';
import { ManageQualificationsImplementation, type ManageQualifications } from '../../access/application/use-cases.js';
import type { AdmissionWorkContext } from './g07b-admission-handler.js';
import { createG10bFirstScopedPersistenceBinder } from './g10b-operation-bridge.js';

type OpenManagementScope = (firstUse?: FirstScopedPersistenceUse) => ManagementScope;

const scopeFactories = new WeakMap<object, OpenManagementScope>();

/**
 * Records the private construction seam of the real access composition.
 * A hand-written ManageQualifications implementation intentionally has no
 * such seam and therefore keeps its pre-G10b behavior.
 */
export function registerG10bManagementScopeFactory(
  management: ManageQualifications,
  openScope: OpenManagementScope,
): void {
  if (typeof management !== 'object' || management === null || typeof openScope !== 'function') {
    throw new TypeError('G10b management scope factory is invalid');
  }
  if (!(management instanceof ManageQualificationsImplementation) || scopeFactories.has(management)) {
    throw new TypeError('G10b management scope factory is already registered or foreign');
  }
  scopeFactories.set(management, openScope);
}

/**
 * Recreates only the internal scope-opening adapter for this exact G07
 * context.  Command validation and business behavior stay in the existing
 * ManageQualifications implementation.
 */
export function createG10bAdmissionBoundManageQualifications(
  management: ManageQualifications,
  admission: AdmissionWorkContext,
): ManageQualifications | null {
  const openScope = scopeFactories.get(management as object);
  if (openScope === undefined) return null;
  const firstUse = createG10bFirstScopedPersistenceBinder(admission);
  if (firstUse === null) return null;
  return new ManageQualificationsImplementation(() => openScope(firstUse));
}
