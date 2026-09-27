/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: [
    '<rootDir>/test/unit/g08b-*.test.js',
    '<rootDir>/test/e2e/g08b-*.test.js',
    '<rootDir>/test/integration/g08b-*.test.js',
  ],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 90_000,
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: [
    '<rootDir>/src/access/application/recognition-result-mapper.js',
    '<rootDir>/src/access/application/internal/recognition-execution.js',
    '<rootDir>/src/composition/internal/g08b-recognition-composition.js',
    '<rootDir>/src/composition/internal/g07b-route-composition.js',
    '<rootDir>/src/composition/internal/source-bound-recognition.js',
    '<rootDir>/src/composition/internal/recognition-event-invariants.js',
  ],
  coverageDirectory: process.env.G08B_COVERAGE_DIRECTORY ?? '<rootDir>/../coverage-g08b',
  coverageReporters: ['text', 'json-summary', 'lcov'],
};
