/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: [
    '<rootDir>/test/unit/g10c-*.test.js',
    '<rootDir>/test/unit/g10a-g07b-writer-permission.test.js',
  ],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 10_000,
  clearMocks: true,
};
