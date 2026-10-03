import {
  G04bMongoPersistenceAdapter,
} from '../../infrastructure/mongo/g04b-persistence-adapter.js';
import {
  attachG10bScopedPersistenceBindingResolver,
} from '../../infrastructure/mongo/internal/g10b-scoped-persistence-sidecar.js';
import { createG10bScopedPersistenceBindingResolver } from './g10b-operation-bridge.js';

const attachedAdapters = new WeakSet<object>();

/**
 * Private bootstrap seam: call once at the concrete adapter construction
 * point, before any management or recognition scope can use that adapter.
 */
export function attachG10bG04bPersistenceSidecar(
  adapter: G04bMongoPersistenceAdapter,
): void {
  if (attachedAdapters.has(adapter as object)) return;
  attachG10bScopedPersistenceBindingResolver(
    adapter,
    createG10bScopedPersistenceBindingResolver(),
  );
  attachedAdapters.add(adapter as object);
}
