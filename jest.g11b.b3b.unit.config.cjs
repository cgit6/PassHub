const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/test/unit/g11b-b3b-persistent-run-claim-mongo.test.js'],
};
