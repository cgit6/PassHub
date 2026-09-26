import * as root from '../../src/index.js';
import * as composition from '../../src/composition/index.js';

void root;
void composition;

// @ts-expect-error G08a HTTP composition remains internal.
root.createG08aManagementComposition;
// @ts-expect-error G08a HTTP composition remains internal.
composition.createG08aManagementComposition;
// @ts-expect-error Persistence envelopes are trusted internal capabilities.
root.readManagementPersistenceEnvelope;
// @ts-expect-error Persistence envelopes are trusted internal capabilities.
root.registerManagementPersistenceEnvelope;
// @ts-expect-error Internal expiry is not a public management operation.
root.createManagementChangePlan;
// @ts-expect-error Raw Mongo management records are not package API.
root.G04bManagementResult;
// @ts-expect-error Mongo persistence implementation is not package API.
root.G04bMongoPersistenceAdapter;
// @ts-expect-error Response-plan issuance remains transport-internal.
composition.createHttpResponsePlanBundle;
