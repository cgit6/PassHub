/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: [
    '<rootDir>/test/integration/g10a-driver-log-mongo.test.js',
    '<rootDir>/test/integration/g10a-recognition-http-mongo.test.js',
  ],
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
