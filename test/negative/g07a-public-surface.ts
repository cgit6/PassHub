import * as root from '../../src/index.js';
import * as composition from '../../src/composition/index.js';

void root;
void composition;

// @ts-expect-error HTTP server construction remains an internal composition capability.
composition.createPassHubHttpApplication;
// @ts-expect-error HTTP server limits are not public package configuration.
composition.HTTP_SERVER_LIMITS;
// @ts-expect-error Raw ingress construction is not a public business capability.
root.createBoundedJsonIngress;
// @ts-expect-error The strict raw JSON parser is not a public package capability.
root.parseStrictJsonObject;
// @ts-expect-error Raw-reader limits are not exposed through the package root.
root.INGRESS_LIMITS;
// @ts-expect-error Internal transport error details are not package-root API.
root.StrictJsonObjectError;
// @ts-expect-error G07b admission construction is neither implemented nor public at G07a.
root.createHttpAdmission;
