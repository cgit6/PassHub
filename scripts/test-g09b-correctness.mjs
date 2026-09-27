import { runG09bCorrectness } from './internal-g09b-runner.mjs';

const workerEnv = process.env.G09B_CORRECTNESS_RESULT === undefined ? {} : { G09B_CORRECTNESS_RESULT: process.env.G09B_CORRECTNESS_RESULT };
await runG09bCorrectness({ workerEnv, report: (message) => process.stderr.write(`${message}\n`) });
