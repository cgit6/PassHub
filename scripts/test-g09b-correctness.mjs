import { runG09bCorrectness } from './internal-g09b-runner.mjs';

await runG09bCorrectness({ report: (message) => process.stderr.write(`${message}\n`) });
