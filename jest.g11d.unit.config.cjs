const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/test/unit/g11d-*.test.js'],
};
