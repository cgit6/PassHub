/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: ['<rootDir>/test/e2e/g09a-*.test.js'],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 20_000,
  clearMocks: true,
  restoreMocks: true,
};
