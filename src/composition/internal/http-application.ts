import 'reflect-metadata';

import {
  Module,
  type INestApplication,
  type NestApplicationOptions,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import {
  createServer,
  type Server as HttpServer,
} from 'node:http';

import {
  createBoundedJsonIngress,
  type AcceptedIngressHandler,
  type BoundedJsonIngress,
} from '../../shared/internal/http/index.js';

export const HTTP_SERVER_LIMITS = Object.freeze({
  connectionsCheckingIntervalMs: 250,
  headersTimeoutMs: 5_000,
  keepAliveTimeoutMs: 5_000,
  keepAliveTimeoutBufferMs: 0,
  maxConnections: 64,
} as const);

@Module({})
class HttpApplicationModule {}

class BoundedExpressAdapter extends ExpressAdapter {
  public override initHttpServer(options: NestApplicationOptions): void {
    if (options.httpsOptions !== undefined) {
      throw new TypeError('G07a bounded adapter does not accept HTTPS options');
    }
    const server = createServer(
      { connectionsCheckingInterval: HTTP_SERVER_LIMITS.connectionsCheckingIntervalMs },
      this.getInstance(),
    );
    server.headersTimeout = HTTP_SERVER_LIMITS.headersTimeoutMs;
    server.keepAliveTimeout = HTTP_SERVER_LIMITS.keepAliveTimeoutMs;
    server.keepAliveTimeoutBuffer = HTTP_SERVER_LIMITS.keepAliveTimeoutBufferMs;
    server.maxConnections = HTTP_SERVER_LIMITS.maxConnections;
    this.setHttpServer(server);
  }
}

export interface PassHubHttpApplication {
  readonly nestApplication: INestApplication;
  readonly server: HttpServer;
  readonly ingress: BoundedJsonIngress;
}

/**
 * Internal-only G07a composition. Business routes are intentionally absent;
 * the accepted seam is wired by later gates after transport validation.
 */
export async function createPassHubHttpApplication(
  onAccepted: AcceptedIngressHandler,
): Promise<PassHubHttpApplication> {
  if (typeof onAccepted !== 'function') throw new TypeError('onAccepted handler is required');

  const expressApplication = express();
  const adapter = new BoundedExpressAdapter(expressApplication);
  const nestApplication = await NestFactory.create(
    HttpApplicationModule,
    adapter,
    { bodyParser: false, logger: false },
  );
  const ingress = createBoundedJsonIngress(onAccepted);
  nestApplication.use(ingress.middleware);
  await nestApplication.init();

  const server: HttpServer = nestApplication.getHttpServer();

  return Object.freeze({ nestApplication, server, ingress });
}
