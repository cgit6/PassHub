/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: [
    '<rootDir>/test/unit/g09a-*.test.js',
    '<rootDir>/test/e2e/g09a-*.test.js',
  ],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 10_000,
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: [
    '<rootDir>/src/access/application/internal/writer-quiescence.js',
    '<rootDir>/src/access/application/internal/query-cursor.js',
    '<rootDir>/src/access/application/internal/persisted-event-invariants.js',
    '<rootDir>/src/access/application/query-application.js',
    '<rootDir>/src/access/application/query-errors.js',
    '<rootDir>/src/composition/internal/g09a-query-composition.js',
    '<rootDir>/src/composition/internal/g07b-route-composition.js',
    '<rootDir>/src/composition/internal/query-admission-binding.js',
    '<rootDir>/src/shared/internal/construction-capture.js',
  ],
  coverageDirectory: '<rootDir>/../coverage-g09a-unit-a',
  coverageReporters: ['text', 'json-summary', 'lcov'],
};
