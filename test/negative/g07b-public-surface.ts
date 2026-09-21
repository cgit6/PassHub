import * as root from '../../src/index.js';
import * as composition from '../../src/composition/index.js';

// @ts-expect-error G07b admission remains internal composition.
root.createG07bAdmissionHandler;
// @ts-expect-error Resource admission is not package API.
root.createAdmissionResourceLedger;
// @ts-expect-error Fixed-minute bookkeeping is not package API.
root.createFixedMinuteRateLedger;
// @ts-expect-error Response ownership is transport-internal.
composition.createHttpResponseOwner;
// @ts-expect-error Response plans are internal capabilities.
composition.createHttpResponsePlanBundle;
// @ts-expect-error Registry observation plumbing remains internal.
composition.createUnknownRecognitionCoordinatorBundle;
// @ts-expect-error Work handoff tokens remain internal.
composition.createAdmissionWorkHandoffBundle;
// @ts-expect-error Exact business-route classification is internal.
composition.classifyBusinessRoute;
