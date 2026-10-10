const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  testMatch: [
    '<rootDir>/test/unit/g12g2-*.test.js',
  ],
  testTimeout: 30_000,
};
