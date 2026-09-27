import * as root from '../../src/index.js';
import * as composition from '../../src/composition/index.js';

void root;
void composition;

// @ts-expect-error G08b recognition composition remains internal.
root.createG08bRecognitionComposition;
// @ts-expect-error G08b recognition composition remains internal.
composition.createG08bRecognitionComposition;
// @ts-expect-error Persistence result facts remain behind Access ports.
root.RecognitionPersistenceResult;
// @ts-expect-error Raw comparison artifacts are not package API.
root.ComparisonArtifact;
// @ts-expect-error Source-bound recognition factory is composition-internal.
root.createSourceBoundRecognitionExecutorFactory;
// @ts-expect-error Principal-to-executor issuer is not a public composition API.
composition.createSourceBoundRecognitionExecutorForPrincipal;
// @ts-expect-error Unknown recovery is opaque and internal to later fault handling.
root.UnknownRecognitionRecoveryToken;
// @ts-expect-error Recovery tokens cannot be minted from the package surface.
composition.issueUnknownRecognitionRecoveryToken;
