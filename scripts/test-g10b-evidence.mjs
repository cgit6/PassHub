import { runG10bEvidence } from './internal-g10b-evidence-runner.mjs';

await runG10bEvidence({ root: process.cwd(), outputRoot: process.env.G10B_EVIDENCE_OUTPUT_ROOT });
