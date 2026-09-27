/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: ['<rootDir>/test/integration/g08b-*.test.js'],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 90_000,
  clearMocks: true,
  restoreMocks: true,
};
