/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: [
    '<rootDir>/test/unit/g08a-*.test.js',
    '<rootDir>/test/e2e/g08a-*.test.js',
    '<rootDir>/test/integration/g08a-*.test.js',
  ],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 30_000,
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: [
    '<rootDir>/src/access/application/management-*.js',
    '<rootDir>/src/access/application/use-cases.js',
    '<rootDir>/src/access/ports/trusted-operation.js',
    '<rootDir>/src/composition/internal/g08a-management-composition.js',
  ],
  coverageDirectory: process.env.G08A_COVERAGE_DIRECTORY ?? '<rootDir>/../coverage-g08a',
  coverageReporters: ['text', 'json-summary', 'lcov'],
};
