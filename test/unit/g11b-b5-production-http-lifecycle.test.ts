import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { closeG11bProductionResources, createG11bProductionHttpHandler, listenG11bProductionServer, takeG11bProductionBusinessListener } from '../../src/deployment/internal/g11b-production-http-lifecycle.js';
import { LocalServiceGate, createOrdinaryReadOnlyServiceGate } from '../../src/composition/internal/g11b-claimed-runtime-bootstrap.js';
import { createPassHubHttpApplication } from '../../src/composition/internal/http-application.js';

afterEach(() => jest.restoreAllMocks());

describe('G11b production raw HTTP lifecycle', () => {
  test('raw handler follows the gate projection, keeps readiness local and forwards business once', () => {
    const gate = createOrdinaryReadOnlyServiceGate();
    // This transport-only test controls the gate projection. The genuine
    // COMPOSING/AUTHORIZABLE/OPEN authority path is tested independently in b4.
    const projection = jest.spyOn(LocalServiceGate.prototype, 'isOpen').mockReturnValue(false);
    const business = jest.fn((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200); response.end('{"business":true}');
    });
    const handler = createG11bProductionHttpHandler(gate, business, '172.31.211.10');
    const invoke = (url: string, peer = '127.0.0.1') => {
      let status = 0;
      let wire = '';
      handler({ url, headers: {}, socket: { remoteAddress: peer } } as IncomingMessage, {
        writeHead: (code: number) => { status = code; }, end: (body: string) => { wire = body; },
      } as unknown as ServerResponse);
      return { status, body: JSON.parse(wire) as Record<string, unknown> };
    };
    expect(invoke('/internal/ready').status).toBe(503);
    expect(invoke('/qualifications').status).toBe(503);
    projection.mockReturnValue(true);
    expect(invoke('/internal/ready')).toEqual({ status: 200, body: { ready: true } });
    expect(invoke('/internal/ready', '172.31.211.10').status).toBe(404);
    expect(invoke('/qualifications')).toEqual({ status: 200, body: { business: true } });
    projection.mockReturnValue(false);
    expect(invoke('/internal/ready').status).toBe(503);
    expect(invoke('/qualifications').status).toBe(503);
    expect(business).toHaveBeenCalledTimes(1);
  });

  test('transferred Node request listener preserves its original server receiver', () => {
    const seen: unknown[] = [];
    const server = createServer(function (this: unknown) { seen.push(this); });
    const transferred = takeG11bProductionBusinessListener(server, true);
    if (transferred === undefined) throw new Error('missing request listener');
    transferred({} as IncomingMessage, {} as ServerResponse);
    expect(seen).toEqual([server]);
  });
  test('concrete Nest Express listener transfers without invoking its HTTP BIND router', async () => {
    const application = await createPassHubHttpApplication(() => undefined);
    try {
      const original = application.server.listeners('request')[0];
      if (original === undefined) throw new Error('missing concrete request listener');
      // Express uses `bind` for HTTP BIND, rather than Function.prototype.bind.
      expect(Object.hasOwn(original, 'bind')).toBe(true);
      expect(typeof takeG11bProductionBusinessListener(application.server, true)).toBe('function');
      expect(application.server.listenerCount('request')).toBe(0);
    } finally {
      await application.nestApplication.close();
    }
  });
  test('claimed server requires exactly one business listener, ordinary server exactly zero', () => {
    const empty = createServer();
    expect(() => takeG11bProductionBusinessListener(empty, true)).toThrow('PRODUCTION_LIFECYCLE_FAILED');
    expect(takeG11bProductionBusinessListener(empty, false)).toBeUndefined();
    const one = createServer(() => undefined);
    expect(() => takeG11bProductionBusinessListener(one, false)).toThrow('PRODUCTION_LIFECYCLE_FAILED');
    expect(one.listenerCount('request')).toBe(1);
    const listener = takeG11bProductionBusinessListener(one, true);
    expect(typeof listener).toBe('function');
    expect(one.listenerCount('request')).toBe(0);
    const duplicate = createServer(() => undefined);
    duplicate.on('request', () => undefined);
    expect(() => takeG11bProductionBusinessListener(duplicate, true)).toThrow('PRODUCTION_LIFECYCLE_FAILED');
    expect(duplicate.listenerCount('request')).toBe(2);
  });

  test.each([[false, false], [true, false], [false, true], [true, true]])(
    'independent ordered cleanup preserves HTTP failure=%s and Mongo failure=%s', async (httpFails, mongoFails) => {
      const order: string[] = [];
      const close = closeG11bProductionResources(async () => {
        order.push('HTTP');
        if (httpFails) throw new Error('private HTTP detail');
      }, async () => {
        order.push('MONGO');
        if (mongoFails) throw new Error('private Mongo detail');
      });
      if (httpFails || mongoFails) {
        await expect(close).rejects.toMatchObject({
          message: 'PRODUCTION_LIFECYCLE_FAILED',
          failures: [...(httpFails ? ['HTTP_CLOSE_FAILED'] : []), ...(mongoFails ? ['MONGO_CLOSE_FAILED'] : [])],
        });
      } else await expect(close).resolves.toBeUndefined();
      expect(order).toEqual(['HTTP', 'MONGO']);
    },
  );

  test('real ephemeral listen detaches startup event handlers and bind error rolls back resources', async () => {
    const first = createServer();
    const second = createServer();
    const firstBaseline = { error: first.listeners('error'), listening: first.listeners('listening') };
    const secondBaseline = { error: second.listeners('error'), listening: second.listeners('listening') };
    try {
      await listenG11bProductionServer(first, 0, '127.0.0.1');
      expect(first.listeners('error')).toEqual(firstBaseline.error);
      expect(first.listeners('listening')).toEqual(firstBaseline.listening);
      const address = first.address();
      if (address === null || typeof address === 'string') throw new Error('missing ephemeral port');
      const order: string[] = [];
      try {
        await listenG11bProductionServer(second, address.port, '127.0.0.1');
        throw new Error('expected bind error');
      } catch (error) {
        expect(error).toMatchObject({ code: 'EADDRINUSE' });
        await closeG11bProductionResources(async () => { order.push('HTTP'); }, async () => { order.push('MONGO'); });
      }
      expect(order).toEqual(['HTTP', 'MONGO']);
      expect(second.listeners('listening')).toEqual(secondBaseline.listening);
      expect(second.listeners('error')).toEqual(secondBaseline.error);
    } finally {
      await new Promise<void>((resolve, reject) => first.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });
});
