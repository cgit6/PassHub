/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: ['<rootDir>/test/unit/g05a-write-operation-coordinator.test.js'],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 10_000,
  clearMocks: true,
};
