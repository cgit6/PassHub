import { runG10aEvidence } from './internal-g10a-evidence-runner.mjs';

await runG10aEvidence({ root: process.cwd(), outputRoot: process.env.G10A_EVIDENCE_OUTPUT_ROOT });
