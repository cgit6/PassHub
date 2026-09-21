import * as root from '../../src/index.js';
import * as composition from '../../src/composition/index.js';
import * as auth from '../../src/auth/index.js';

void root;
void composition;
void auth;

// @ts-expect-error Source Auth construction is internal composition only.
root.createSourceAuth;
// @ts-expect-error Source verifier construction is never a package-root capability.
root.createSourceCredentialVerifier;
// @ts-expect-error Mongo credential reader is internal infrastructure.
root.MongoSourceCredentialReader;
// @ts-expect-error Source principal issuance is not public.
root.SourcePrincipal;
// @ts-expect-error Internal Source Auth composition is absent from public composition.
composition.createSourceAuthComposition;
// @ts-expect-error Source verifier factory is absent from public composition.
composition.createSourceCredentialVerifier;
// @ts-expect-error Public human Auth surface does not issue Source principals.
auth.SourcePrincipal;
// @ts-expect-error Public human Auth surface does not expose Source Auth factory.
auth.createSourceAuth;
