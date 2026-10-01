import {
  G04bMongoPersistenceAdapter,
} from '../../infrastructure/mongo/g04b-persistence-adapter.js';
import {
  attachG10bScopedPersistenceBindingResolver,
} from '../../infrastructure/mongo/internal/g10b-scoped-persistence-sidecar.js';
import { createG10bScopedPersistenceBindingResolver } from './g10b-operation-bridge.js';

/**
 * Private bootstrap seam: call once at the concrete adapter construction
 * point, before any management or recognition scope can use that adapter.
 */
export function attachG10bG04bPersistenceSidecar(
  adapter: G04bMongoPersistenceAdapter,
): void {
  attachG10bScopedPersistenceBindingResolver(
    adapter,
    createG10bScopedPersistenceBindingResolver(),
  );
}
