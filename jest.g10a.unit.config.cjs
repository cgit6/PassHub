/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: ['<rootDir>/test/unit/g10a-*.test.js'],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 10_000,
  clearMocks: true,
  reporters: process.env.G10A_SAFE_JEST_REPORT_PATH === undefined && process.env.G10A_SAFE_JEST_REPORT_PHASE === undefined
    ? undefined
    : ['default', '<rootDir>/../scripts/g10a-safe-jest-reporter.mjs'],
};
