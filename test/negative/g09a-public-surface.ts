import * as root from '../../src/index.js';
import * as composition from '../../src/composition/index.js';

void root;
void composition;

// @ts-expect-error G09a query application remains internal.
root.createQueryApplication;
// @ts-expect-error Cursor codecs are not public caller capabilities.
root.createQueryCursorCodec;
// @ts-expect-error Raw query persistence rows are not public DTOs.
root.QuerySnapshotQualification;
// @ts-expect-error Raw Event persistence rows are not public DTOs.
root.QuerySnapshotEvent;
// @ts-expect-error Writer quiescence control is composition-internal.
composition.createWriterQuiescence;
// @ts-expect-error Read observation leases cannot be acquired publicly.
composition.ReadObservationLease;
// @ts-expect-error Persistence invariant assertions remain internal.
root.assertPersistedEventInvariant;
// @ts-expect-error G09a transport composition remains internal.
root.createG09aQueryComposition;
// @ts-expect-error Neutral admission identity lookup is never public.
composition.getQueryAdmissionIdentity;
// @ts-expect-error Construction capture primitives remain internal.
root.captureConstructionMethod;
// @ts-expect-error Legacy query admission factory is direct-internal test wiring only.
composition.createLegacyQueryAdmissionCapability;
// @ts-expect-error Nominal query admission capability is not public API.
root.QueryAdmissionCapability;
