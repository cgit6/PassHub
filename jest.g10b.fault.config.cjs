/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: [
    '<rootDir>/test/integration/g10b-precommit-mongo-wire-probe.test.js',
    '<rootDir>/test/integration/g10b-attached-g04b-fault.test.js',
  ],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 60_000,
  clearMocks: true,
};
