const unit = require('./jest.g07b.unit.config.cjs');
module.exports = {
  ...unit,
  testMatch: [
    '<rootDir>/test/unit/g07b-*.test.js',
    '<rootDir>/test/e2e/g07b-*.test.js',
  ],
  collectCoverageFrom: [
    '<rootDir>/src/composition/internal/{admission-resource-ledger,admission-work-handoff,fixed-minute-rate-ledger,g07b-admission-handler,http-response-owner,http-response-plan,unknown-recognition-coordinator}.js',
    '<rootDir>/src/shared/internal/http/business-route-classifier.js',
  ],
};
