import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';

import { MongoClient } from 'mongodb';

import { resolveIngressClientAddress } from './ingress-client-address.js';
import { createG11bProductionApplication, G11bProductionAuthorityError, type G11bProductionApplication } from './internal/g11b-production-application.js';
import { G11B_PROCESS_IDENTITY_PATH, ProcessIdentityIntakeError } from './internal/g11b-process-identity-intake.js';
import { RunTicketIntakeError } from './internal/g11b-run-ticket-intake.js';
import { DatasetVerificationError } from './internal/g11b-dataset-verification.js';
import { closeG11bProductionResources, createG11bProductionHttpHandler, G11bProductionLifecycleError, listenG11bProductionServer, takeG11bProductionBusinessListener } from './internal/g11b-production-http-lifecycle.js';
import { installG11bProductionShutdown } from './internal/g11b-production-shutdown.js';
import { DatasetDescriptorIntakeError } from './internal/g12g1-dataset-descriptor-intake.js';
import {
  DeploymentProfileConfigError,
  parseDeploymentProfile,
  resolveProductionDatasetTarget,
  type DeploymentProfile,
  type ProductionDatasetTarget,
} from './internal/g12g1-deployment-profile.js';
import {
  MongoCapabilityVerificationError,
  verifyProductionMongoCapabilities,
} from './internal/g12g2-mongo-capability-verification.js';

const MAX_SECRET_BYTES = 4_096;
const PROCESS_IDENTITY_FILE_NAME = 'process-run-id';
let startupStage = 'CONFIG';

interface DeploymentConfig {
  readonly profile: DeploymentProfile;
  readonly datasetTarget: ProductionDatasetTarget;
  readonly host: string;
  readonly port: number;
  readonly trustedProxyIp: string;
  readonly mongoUri: string;
  readonly probeMode: boolean;
  readonly jwtKey: Buffer;
  readonly comparisonKey: Buffer;
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
  const profile = parseDeploymentProfile(process.env.PASSHUB_DEPLOYMENT_PROFILE);
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
  const probeMode = probe === '1';
  const datasetTarget = await resolveProductionDatasetTarget(profile, probeMode);
  if (probe !== '1' && (Buffer.byteLength(jwtKey, 'utf8') !== 32 || !/^[0-9a-f]{64}$/u.test(comparisonKey))) {
    throw new Error('deployment secret is invalid');
  }
  return Object.freeze({
    profile, datasetTarget, host, port, trustedProxyIp, mongoUri, probeMode,
    jwtKey: Buffer.from(jwtKey, 'utf8'), comparisonKey: Buffer.from(comparisonKey, 'hex'),
  });
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
  if (!G11B_PROCESS_IDENTITY_PATH.endsWith(`/${PROCESS_IDENTITY_FILE_NAME}`)) throw new Error('deployment process identity path is invalid');
  const config = await loadConfig();
  startupStage = 'MONGO_CONNECT';
  const mongo = new MongoClient(config.mongoUri, {
    retryReads: false,
    retryWrites: false,
    monitorCommands: true,
    maxAdaptiveRetries: 0,
    maxPoolSize: 8,
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
  });
  try {
    await mongo.connect();
    startupStage = 'MONGO_CAPABILITY';
    await verifyProductionMongoCapabilities(mongo, config.profile);
  } catch (error) {
    await mongo.close().catch(() => undefined);
    throw error;
  }

  let production: G11bProductionApplication | undefined;
  try {
    startupStage = 'DATASET_COMPOSITION';
    if (!config.probeMode) {
      production = await createG11bProductionApplication(
        mongo,
        config.datasetTarget,
        config.jwtKey,
        config.comparisonKey,
      );
    }
  } catch (error) {
    await mongo.close();
    throw error;
  }
  const server = production?.application?.application.server ?? createServer();
  let businessHandler;
  try {
    startupStage = 'LISTENER_COMPOSITION';
    businessHandler = takeG11bProductionBusinessListener(server, production !== undefined && production.application !== null);
  } catch (error) {
    await closeG11bProductionResources(async () => { await production?.close(); }, () => mongo.close()).catch(() => undefined);
    throw error;
  }
  const productionHandler = production === undefined ? undefined
    : createG11bProductionHttpHandler(production.serviceGate, businessHandler, config.trustedProxyIp);
  let forwardedRequests = 0;
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    if (productionHandler !== undefined) return productionHandler(request, response);
    const ingress = resolveIngressClientAddress(
      request.socket.remoteAddress,
      request.headers['x-forwarded-for'],
      config.trustedProxyIp,
    );
    const peer = ingress.peerAddress;
    if (request.url === '/internal/ready') {
      if (peer !== '127.0.0.1' && peer !== '::1') return reply(response, 404, { code: 'NOT_FOUND' });
      const ready = config.probeMode || production?.serviceGate.isOpen() === true;
      return ready ? reply(response, 200, { ready: true }) : reply(response, 503, { code: 'SERVICE_NOT_READY' });
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
  server.on('request', handler);
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 64;
  try {
    startupStage = 'LISTEN';
    await listenG11bProductionServer(server, config.port, config.host);
  } catch (error) {
    await closeG11bProductionResources(async () => { await production?.close(); }, () => mongo.close()).catch(() => undefined);
    throw error;
  }

  startupStage = 'READY';
  installG11bProductionShutdown({
    beginShutdown: () => { production?.serviceGate.beginShutdown(); },
    closeHttp: async () => {
      if (production !== undefined && production.application !== null) await production.close();
      else await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    },
    closeMongo: () => mongo.close(),
  });
}

main().catch((error: unknown) => {
  const code = error instanceof G11bProductionAuthorityError || error instanceof ProcessIdentityIntakeError
    || error instanceof RunTicketIntakeError || error instanceof DatasetVerificationError
    || error instanceof DatasetDescriptorIntakeError || error instanceof DeploymentProfileConfigError
    || error instanceof MongoCapabilityVerificationError
    ? error.code : error instanceof G11bProductionLifecycleError ? error.failures.join('+') : 'STARTUP_UNAVAILABLE';
  process.stderr.write(`PassHub deployment startup failed: ${startupStage}:${code}\n`);
  process.exitCode = 1;
});
