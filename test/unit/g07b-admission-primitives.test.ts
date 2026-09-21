import { EventEmitter } from 'node:events';

import {
  ADMISSION_RESOURCE_LIMITS,
  AdmissionResourceError,
  RateLimitError,
  createAdmissionResourceLedger,
  createAdmissionWorkHandoffBundle,
  createConfigurableFixedMinuteRateLedger,
  createHttpResponseOwner,
  createHttpResponsePlanBundle,
  createUnknownRecognitionCoordinatorBundle,
} from '../../src/composition/internal/index.js';
import { classifyBusinessRoute } from '../../src/shared/internal/http/index.js';
import type { NarrowHttpResponse } from '../../src/composition/internal/index.js';
import type { OperationConfirmationLease, OperationObservationReference } from '../../src/access/application/internal/operation-registry.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';

describe('G07b exact business route classification', () => {
  test.each([
    ['POST', '/auth/login', 'AUTH_LOGIN'],
    ['POST', '/qualifications', 'QUALIFICATION_CREATE'],
    ['PATCH', '/qualifications/q1', 'QUALIFICATION_UPDATE'],
    ['POST', '/qualifications/q1/revoke', 'QUALIFICATION_REVOKE'],
    ['GET', '/qualifications', 'QUALIFICATION_LIST'],
    ['GET', '/qualifications/inside', 'QUALIFICATION_INSIDE_LIST'],
    ['GET', '/qualifications/q1', 'QUALIFICATION_DETAIL'],
    ['GET', '/events', 'EVENT_LIST'],
    ['GET', '/events/e1', 'EVENT_DETAIL'],
    ['POST', '/recognition/attempts', 'RECOGNITION_ATTEMPT'],
  ])('%s %s is exactly %s', (method, requestTarget, routeId) => {
    expect(classifyBusinessRoute({ method, requestTarget })).toMatchObject({ kind: 'MATCHED', routeId });
  });

  test.each([
    ['post', '/auth/login'], ['GET', '/auth/login'], ['POST', '/auth/login/'],
    ['GET', '/qualifications/inside/'], ['GET', '/qualifications/inside/revoke'],
    ['GET', '/events/a/b'], ['POST', 'https://host/auth/login'],
  ])('rejects method/path variation %s %s', (method, requestTarget) => {
    expect(classifyBusinessRoute({ method, requestTarget })).toEqual({ kind: 'NO_MATCH' });
  });

  test('query is ignored, inside wins over dynamic, retry is recognition-only', () => {
    expect(classifyBusinessRoute({ method: 'GET', requestTarget: '/qualifications/inside?x=1' }))
      .toMatchObject({ routeId: 'QUALIFICATION_INSIDE_LIST', parameters: {} });
    expect(classifyBusinessRoute({ method: 'POST', requestTarget: '/auth/login', retryMode: 'existing-only' }))
      .toMatchObject({ kind: 'INVALID_RETRY_MODE', routeId: 'AUTH_LOGIN' });
    expect(classifyBusinessRoute({ method: 'POST', requestTarget: '/recognition/attempts', retryMode: 'existing-only' }))
      .toMatchObject({ kind: 'MATCHED', retryMode: 'EXISTING_ONLY' });
    expect(classifyBusinessRoute({ method: 'POST', requestTarget: '/recognition/attempts', retryMode: 'EXISTING-ONLY' }))
      .toMatchObject({ kind: 'INVALID_RETRY_MODE' });
  });
});

describe('G07b admission resource pools', () => {
  test.each([
    ['MANAGEMENT', 'httpOrdinary', 'validationWrite', 'origin'],
    ['NORMAL_RECOGNITION', 'httpOrdinary', 'validationWrite', 'origin'],
    ['LOGIN', 'httpOrdinary', 'validationLogin', null],
    ['QUERY', 'httpOrdinary', 'validationQuery', null],
    ['EXISTING_ONLY', 'httpRetry', 'validationRetry', null],
  ] as const)('%s borrows only its own pools and releases independently', (kind, http, validation, origin) => {
    const ledger = createAdmissionResourceLedger();
    const lease = ledger.tryAcquire(kind)!;
    expect(ledger.snapshot()[http].used).toBe(1);
    expect(ledger.snapshot()[validation].used).toBe(1);
    expect(ledger.snapshot().origin.used).toBe(origin === null ? 0 : 1);
    ledger.releaseHttp(lease.http);
    ledger.releaseValidation(lease.validation);
    if (lease.origin !== null) ledger.releaseOrigin(lease.origin);
    expect(Object.values(ledger.snapshot()).every((pool) => pool.used === 0)).toBe(true);
  });

  test('each ancillary pool enforces N/N+1 and has foreign/double-release fences', () => {
    for (const [name, limit] of Object.entries({ scrypt: 1, queryDb: 1, canonicalReplay: 2, originalConfirm: 1 }) as [keyof ReturnType<typeof createAdmissionResourceLedger>['ancillary'], number][]) {
      const a = createAdmissionResourceLedger();
      const b = createAdmissionResourceLedger();
      const leases = Array.from({ length: limit }, () => a.ancillary[name].tryAcquire()!);
      expect(a.ancillary[name].tryAcquire()).toBeNull();
      expect(() => b.ancillary[name].release(leases[0]!)).toThrow(AdmissionResourceError);
      a.ancillary[name].release(leases[0]!);
      expect(() => a.ancillary[name].release(leases[0]!)).toThrow(AdmissionResourceError);
      for (const lease of leases.slice(1)) a.ancillary[name].release(lease);
    }
  });

  test('ordinary exhaustion cannot borrow retry and failed bundle acquisition rolls back all pools', () => {
    const ledger = createAdmissionResourceLedger();
    const login = ledger.tryAcquire('LOGIN')!;
    expect(ledger.tryAcquire('LOGIN')).toBeNull();
    expect(ledger.snapshot()).toMatchObject({ httpOrdinary: { used: 1 }, validationLogin: { used: 1 }, httpRetry: { used: 0 } });
    ledger.releaseHttp(login.http); ledger.releaseValidation(login.validation);
    expect(ADMISSION_RESOURCE_LIMITS.httpOrdinary).toBe(28);
  });
});

describe('G07b fixed-minute rates', () => {
  const limits = {
    login: { perKey: 2, global: 3, maxKeys: 2 }, query: { perKey: 2, global: 3 },
    recognition: { perKey: 2, global: 3 }, management: { perKey: 2, global: 3 },
  };
  test('enforces per-key, global, max-key and resets only on minute rollover', () => {
    let now = 0;
    const rates = createConfigurableFixedMinuteRateLedger({ clock: { nowMs: () => now } }, limits);
    expect(rates.login.allow('a').kind).toBe('ALLOWED');
    expect(rates.login.allow('a').kind).toBe('ALLOWED');
    expect(rates.login.allow('a').kind).toBe('RATE_LIMITED');
    expect(rates.login.allow('b').kind).toBe('ALLOWED');
    expect(rates.login.allow('c').kind).toBe('RATE_LIMITED');
    now = 60_000;
    expect(rates.login.allow('c').kind).toBe('ALLOWED');
  });
  test('clock rollback/reentry freezes every category', () => {
    let now = 1;
    const rates = createConfigurableFixedMinuteRateLedger({ clock: { nowMs: () => now } }, limits);
    rates.query.allow('a'); now = 0;
    expect(() => rates.query.allow('a')).toThrow(RateLimitError);
    expect(() => rates.login.allow('a')).toThrow(RateLimitError);
    let nested!: ReturnType<typeof createConfigurableFixedMinuteRateLedger>;
    nested = createConfigurableFixedMinuteRateLedger({ clock: { nowMs: () => { nested.login.allow('x'); return 0; } } }, limits);
    expect(() => nested.query.allow('x')).toThrow(RateLimitError);
  });
  test('production login retains all 256 prior IPs when the 257th is rejected', () => {
    const rates = createConfigurableFixedMinuteRateLedger({ clock: { nowMs: () => 0 } }, {
      ...limits, login: { perKey: 5, global: 1000, maxKeys: 256 },
    });
    for (let i = 0; i < 256; i += 1) expect(rates.login.allow(`ip-${i}`).kind).toBe('ALLOWED');
    expect(rates.login.allow('ip-256').kind).toBe('RATE_LIMITED');
    expect(rates.login.allow('ip-0').kind).toBe('ALLOWED');
    expect(rates.snapshot().login.keyCount).toBe(256);
  });
});

describe('G07b opaque capabilities and response plans', () => {
  test('work tokens are payload-free, route-scoped, one-shot and issuer-local', () => {
    const a = createAdmissionWorkHandoffBundle(); const b = createAdmissionWorkHandoffBundle();
    const token = a.issuer.issue('AUTH_LOGIN');
    expect(Reflect.ownKeys(token)).toEqual([]);
    expect(() => b.claimer.claim(token, 'AUTH_LOGIN')).toThrow();
    expect(() => a.claimer.claim(token, 'QUERY' as never)).toThrow();
    expect(() => a.claimer.claim(token, 'AUTH_LOGIN')).toThrow();
  });
  test('plans bind epoch/issuer, snapshot payload, reject accessor/proxy/raw errors/body overflow', () => {
    const a = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH, maxBodyBytes: 150 });
    const b = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const payload: Record<string, unknown> = { ok: true };
    const plan = a.business.issue(200, payload); payload.ok = false;
    expect(JSON.parse(a.renderer.render(plan).body)).toMatchObject({ ok: true, currentDatasetEpoch: EPOCH });
    expect(() => b.renderer.render(plan)).toThrow();
    expect(() => a.business.issue(200, new Proxy({}, {}))).toThrow();
    expect(() => a.business.issue(200, Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 }))).toThrow();
    expect(() => a.business.issue(200, { stack: 'secret' })).toThrow();
    expect(() => a.business.issue(200, { value: 'x'.repeat(200) })).toThrow();
  });
  test('unknown receipts require canonical input and are accept/take one-shot', () => {
    const bundle = createUnknownRecognitionCoordinatorBundle();
    const item = Object.freeze({
      confirmationLease: Object.freeze({ generation: 1 }) as OperationConfirmationLease,
      operation: Object.freeze({ operationId: 'o', receivedAtMs: 1, sequence: 0n }),
      observationReference: Object.freeze({}) as OperationObservationReference,
    });
    const receipt = bundle.handler.offer(item); bundle.handler.accept(receipt);
    expect(bundle.drain.drain()).toEqual([receipt]);
    expect(bundle.drain.take(receipt)).toEqual(item);
    expect(() => bundle.drain.take(receipt)).toThrow();
    expect(() => bundle.handler.accept(receipt)).toThrow();
    expect(() => bundle.handler.accept(Object.freeze({}) as never)).toThrow();
  });
});

class FakeResponse extends EventEmitter implements NarrowHttpResponse {
  statusCode = 0; writableEnded = false; destroyed = false;
  headers = new Map<string, string | number>(); bodies: string[] = [];
  setHeader(name: string, value: string | number): void { this.headers.set(name, value); }
  end(body: string): void { this.bodies.push(body); this.writableEnded = true; this.emit('finish'); }
  override once(event: 'finish' | 'close', listener: () => void): this { return super.once(event, listener); }
  override off(event: 'finish' | 'close', listener: () => void): this { return super.off(event, listener); }
}

describe('G07b exact five-second response owner', () => {
  test('uses receipt age, single-writes, and releases exactly once across late callback/close', () => {
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const response = new FakeResponse(); let callback!: () => void; let delay = -1; let released = 0;
    const owner = createHttpResponseOwner({ response, receipt: { registeredAtMonotonicMs: 100 }, releaseHttp: () => { released += 1; },
      responsePlanRenderer: plans.renderer, fallbackPlan: plans.technical.issue('REQUEST_STATUS_UNCONFIRMED'),
      deadlineResponse: () => plans.technical.issue('REQUEST_IN_PROGRESS'), clock: { nowMs: () => 1100 },
      scheduler: { setTimeout: (cb, ms) => { callback = cb; delay = ms; return 1; }, clearTimeout: () => undefined } });
    expect(delay).toBe(4000); callback();
    expect(response.statusCode).toBe(202); expect(response.bodies).toHaveLength(1); expect(released).toBe(1);
    expect(owner.tryRespond(plans.business.issue(200, { ok: true }))).toBe(false);
    response.emit('close'); callback(); expect(released).toBe(1); expect(response.bodies).toHaveLength(1);
  });
  test('preclosed response releases without arming and write reentry cannot win twice', () => {
    const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
    const response = new FakeResponse(); response.destroyed = true; let released = 0; let armed = 0;
    const owner = createHttpResponseOwner({ response, receipt: { registeredAtMonotonicMs: 0 }, releaseHttp: () => { released += 1; },
      responsePlanRenderer: plans.renderer, fallbackPlan: plans.technical.issue('REQUEST_STATUS_UNCONFIRMED'), deadlineResponse: () => plans.technical.issue('REQUEST_IN_PROGRESS'),
      clock: { nowMs: () => 0 }, scheduler: { setTimeout: () => { armed += 1; return 1; }, clearTimeout: () => undefined } });
    expect(owner.snapshot().state).toBe('CLOSED'); expect(released).toBe(1); expect(armed).toBe(0);
  });
});
