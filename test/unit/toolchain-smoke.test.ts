import { toolchainBaseline } from '../../src/composition/toolchain-smoke.js';

test('the locked application dependencies load through compiled CommonJS', () => {
  expect(toolchainBaseline).toEqual({
    nestFactory: 'function',
    expressAdapter: 'function',
    jwtModule: 'function',
    swaggerModule: 'function',
    express: 'function',
    jsonwebtoken: 'function',
    mongoClient: 'function',
  });
});
