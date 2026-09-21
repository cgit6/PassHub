/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: [
    '<rootDir>/test/unit/g07a-strict-json.test.js',
    '<rootDir>/test/e2e/g07a-http-ingress.test.js',
  ],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 60_000,
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: [
    '<rootDir>/src/shared/internal/http/**/*.js',
    '<rootDir>/src/composition/internal/http-application.js',
  ],
  coverageDirectory: '<rootDir>/../coverage/g07a',
  coverageReporters: ['text', 'json-summary', 'lcov'],
};
