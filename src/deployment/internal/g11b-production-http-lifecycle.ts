import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { LocalServiceGate } from '../../composition/internal/g11b-claimed-runtime-bootstrap.js';
import { resolveIngressClientAddress } from '../ingress-client-address.js';
import { bindTrustedIngressClientAddress } from '../../composition/internal/trusted-ingress-client-address.js';

export type ProductionBusinessListener = (request: IncomingMessage, response: ServerResponse) => void;

export class G11bProductionLifecycleError extends Error {
  constructor(readonly failures: readonly ('HTTP_COMPOSITION_INVALID' | 'HTTP_CLOSE_FAILED' | 'MONGO_CLOSE_FAILED')[]) {
    super('PRODUCTION_LIFECYCLE_FAILED');
    this.name = 'G11bProductionLifecycleError';
    Object.freeze(failures);
  }
}

export function takeG11bProductionBusinessListener(server: Server, claimed: boolean): ProductionBusinessListener | undefined {
  const listeners = server.listeners('request');
  if (listeners.length !== (claimed ? 1 : 0)) throw new G11bProductionLifecycleError(['HTTP_COMPOSITION_INVALID']);
  const business = listeners[0] as ProductionBusinessListener | undefined;
  if (business !== undefined) server.removeListener('request', business);
  // Express exposes an HTTP BIND route method on its callable application;
  // do not dispatch through an own `bind` property on the listener.
  return business === undefined ? undefined : Function.prototype.bind.call(business, server) as ProductionBusinessListener;
}

export function createG11bProductionHttpHandler(
  serviceGate: LocalServiceGate,
  business: ProductionBusinessListener | undefined,
  trustedProxyIp: string,
): ProductionBusinessListener {
  return (request, response): void => {
    const ingress = resolveIngressClientAddress(request.socket.remoteAddress, request.headers['x-forwarded-for'], trustedProxyIp);
    const peer = ingress.peerAddress;
    if (request.url === '/internal/ready') {
      if (peer !== '127.0.0.1' && peer !== '::1') return reply(response, 404, { code: 'NOT_FOUND' });
      return serviceGate.isOpen() ? reply(response, 200, { ready: true }) : reply(response, 503, { code: 'SERVICE_NOT_READY' });
    }
    if (!serviceGate.isOpen() || business === undefined) return reply(response, 503, { code: 'SERVICE_NOT_READY' });
    bindTrustedIngressClientAddress(request, ingress.clientAddress);
    business(request, response);
  };
}

/** Close HTTP/runtime first; a failure must still attempt the Mongo close. */
export async function closeG11bProductionResources(closeHttp: () => Promise<void>, closeMongo: () => Promise<void>): Promise<void> {
  const failures: Array<'HTTP_CLOSE_FAILED' | 'MONGO_CLOSE_FAILED'> = [];
  try { await closeHttp(); } catch { failures.push('HTTP_CLOSE_FAILED'); }
  try { await closeMongo(); } catch { failures.push('MONGO_CLOSE_FAILED'); }
  if (failures.length > 0) throw new G11bProductionLifecycleError(failures);
}

export function listenG11bProductionServer(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { server.removeListener('listening', listened); reject(error); };
    const listened = (): void => { server.removeListener('error', failed); resolve(); };
    server.once('error', failed);
    server.once('listening', listened);
    server.listen(port, host);
  });
}

function reply(response: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  const wire = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(wire)), 'cache-control': 'no-store',
  });
  response.end(wire);
}
