import type { AccessComposition } from 'passhub';
import * as publicApi from 'passhub';

declare const composition: AccessComposition;

// The public package exposes use-case commands, not application staging controls.
// @ts-expect-error public management surface must not expose staging
composition.manageQualifications.stageManagementChange({});
// @ts-expect-error public management surface must not expose presence mutation
composition.manageQualifications.setPresence('q-1', 'INSIDE');
// @ts-expect-error public management surface must not expose a raw repository
composition.manageQualifications.rawRepository.findOne({});

// Opaque handles and trusted plans are internal application authority.
// @ts-expect-error handle constructors must not be public
publicApi.createResolutionHandle({});
// @ts-expect-error plan factories must not be public
publicApi.createRecognitionResultPlan({}, {});
// @ts-expect-error management plan factories must not be public
publicApi.createManagementChangePlan({});
