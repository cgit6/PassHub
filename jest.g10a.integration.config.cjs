/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: ['<rootDir>/test/integration/g10a-driver-log-mongo.test.js'],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 60_000,
  clearMocks: true,
};
