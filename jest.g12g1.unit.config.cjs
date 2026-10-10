const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  testMatch: [
    '<rootDir>/test/unit/g12g1-*.test.js',
    '<rootDir>/test/unit/g11b-b5-production-application.test.js',
  ],
  testTimeout: 30_000,
};
