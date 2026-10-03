const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/test/unit/g11b-b5-process-identity.test.js'],
};
