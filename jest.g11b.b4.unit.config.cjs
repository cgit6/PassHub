const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/test/unit/g11b-b4-claimed-runtime-bootstrap.test.js'],
};
