import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';

import { MongoClient } from 'mongodb';

import { resolveIngressClientAddress } from './ingress-client-address.js';

const MAX_SECRET_BYTES = 4_096;
const SHUTDOWN_DEADLINE_MS = 25_000;

interface DeploymentConfig {
  readonly host: string;
  readonly port: number;
  readonly trustedProxyIp: string;
  readonly mongoUri: string;
  readonly probeMode: boolean;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.includes('\0')) throw new Error('deployment configuration is invalid');
  return value;
}

function exactPort(raw: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(raw)) throw new Error('deployment configuration is invalid');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 65_535) throw new Error('deployment configuration is invalid');
  return value;
}

async function readSecret(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > MAX_SECRET_BYTES || bytes.includes(0)) throw new Error('deployment secret is invalid');
  const value = bytes.toString('utf8').replace(/\n$/u, '');
  if (Buffer.byteLength(value, 'utf8') === 0 || value.includes('\r') || value.includes('\n')) throw new Error('deployment secret is invalid');
  return value;
}

async function loadConfig(): Promise<DeploymentConfig> {
  const host = requiredEnvironment('PASSHUB_HTTP_HOST');
  const port = exactPort(requiredEnvironment('PASSHUB_HTTP_PORT'));
  const trustedProxyIp = requiredEnvironment('PASSHUB_TRUSTED_PROXY_IP');
  if (isIP(trustedProxyIp) !== 4) throw new Error('deployment configuration is invalid');
  const mongoUri = await readSecret(requiredEnvironment('PASSHUB_MONGO_URI_FILE'));
  const jwtKey = await readSecret(requiredEnvironment('PASSHUB_JWT_KEY_FILE'));
  const comparisonKey = await readSecret(requiredEnvironment('PASSHUB_COMPARISON_KEY_FILE'));
  if (Buffer.byteLength(jwtKey, 'utf8') < 32 || Buffer.byteLength(comparisonKey, 'utf8') < 32 || jwtKey === comparisonKey) {
    throw new Error('deployment secret is invalid');
  }
  const probe = process.env.PASSHUB_G11A_PROBE_MODE;
  if (probe !== undefined && probe !== '1') throw new Error('deployment configuration is invalid');
  return Object.freeze({ host, port, trustedProxyIp, mongoUri, probeMode: probe === '1' });
}

function reply(response: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  const wire = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(wire)),
    'cache-control': 'no-store',
  });
  response.end(wire);
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const mongo = new MongoClient(config.mongoUri, {
    retryReads: false,
    retryWrites: false,
    maxAdaptiveRetries: 0,
    maxPoolSize: 8,
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
  });
  await mongo.connect();
  const hello = await mongo.db('admin').command({ hello: 1 }) as { setName?: unknown; isWritablePrimary?: unknown; hosts?: unknown };
  if (hello.setName !== 'rs0' || hello.isWritablePrimary !== true || !Array.isArray(hello.hosts) || hello.hosts.length !== 1) {
    await mongo.close();
    throw new Error('deployment database is not ready');
  }

  let forwardedRequests = 0;
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const ingress = resolveIngressClientAddress(
      request.socket.remoteAddress,
      request.headers['x-forwarded-for'],
      config.trustedProxyIp,
    );
    const peer = ingress.peerAddress;
    if (request.url === '/internal/ready') {
      if (peer !== '127.0.0.1' && peer !== '::1') return reply(response, 404, { code: 'NOT_FOUND' });
      return reply(response, 200, { ready: true });
    }
    if (config.probeMode && request.url === '/__g11a/observations') {
      if (peer !== '127.0.0.1' && peer !== '::1') return reply(response, 404, { code: 'NOT_FOUND' });
      return reply(response, 200, { forwardedRequests });
    }
    if (config.probeMode && request.url === '/__g11a/probe') {
      forwardedRequests += 1;
      return reply(response, 200, {
        peer,
        trustedProxy: ingress.trustedProxy,
        clientAddress: ingress.clientAddress,
        forwarded: request.headers.forwarded ?? null,
      });
    }
    return reply(response, 503, { code: 'SERVICE_NOT_READY' });
  };
  const server = createServer(handler);
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    try {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await mongo.close();
      clearTimeout(deadline);
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
}

main().catch(() => {
  process.stderr.write('PassHub deployment startup failed\n');
  process.exitCode = 1;
});
