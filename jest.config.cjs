/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'dist',
  testMatch: ['<rootDir>/test/unit/**/*.test.js'],
  testEnvironment: 'node',
  maxWorkers: 1,
  detectOpenHandles: true,
  forceExit: false,
  testTimeout: 10_000,
  clearMocks: true,
  collectCoverageFrom: ['<rootDir>/src/**/*.js'],
  coverageDirectory: '<rootDir>/../coverage',
  coverageReporters: ['text', 'json-summary', 'lcov'],
};
