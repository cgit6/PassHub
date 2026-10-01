/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  // Real AF_UNIX and child-process cases have legitimate wall-clock waits;
  // keep them out of the 10-second pure-unit tier.
  testMatch: ['<rootDir>/test/socket/g10a-*.test.js'],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 60_000,
  clearMocks: true,
  reporters: process.env.G10A_SAFE_JEST_REPORT_PATH === undefined && process.env.G10A_SAFE_JEST_REPORT_PHASE === undefined
    ? undefined
    : ['default', '<rootDir>/../scripts/g10a-safe-jest-reporter.mjs'],
};
