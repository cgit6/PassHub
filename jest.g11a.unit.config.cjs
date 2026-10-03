const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/test/unit/g11a-topology-contract.test.js'],
};
