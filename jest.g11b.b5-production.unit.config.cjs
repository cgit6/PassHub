const base = require('./jest.config.cjs');
module.exports = { ...base, testMatch: [
  '<rootDir>/test/unit/g11b-b5-production-application.test.js',
  '<rootDir>/test/unit/g11b-b5-production-http-lifecycle.test.js',
  '<rootDir>/test/unit/g11b-b5-production-shutdown.test.js',
  '<rootDir>/test/unit/g11b-b5-production-comparison.test.js',
  '<rootDir>/test/unit/g11b-b5-trusted-ingress-address.test.js',
  '<rootDir>/test/unit/g11b-b5-production-login.test.js',
] };
