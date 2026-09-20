import * as root from '../../src/index.js';

void root;

// @ts-expect-error Auth construction is composition-internal, not a package-root capability.
root.createHumanAuth;
// @ts-expect-error Signing key material must never be exported.
root.JWT_KEY;
// @ts-expect-error Stored account records must never be exported.
root.AccountRecord;
// @ts-expect-error Password codec/deriver details must never be exported.
root.NodeScryptPasswordDeriver;
// @ts-expect-error Mongo account records/readers must never be exported.
root.MongoHumanAccountReader;
// @ts-expect-error Principal issuance is private to an auth capability.
root.issueHumanPrincipal;
