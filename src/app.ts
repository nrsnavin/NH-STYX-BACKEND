import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './config/logger';
import apiRoutes from './routes';
import webhookRoutes from './modules/webhooks/webhook.routes';
import { UPLOAD_DIR } from './modules/uploads/upload.routes';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { tenantContext } from './middlewares/tenantContext.middleware';

export function createApp(): Application {
  const app = express();

  // Security & infrastructure middleware.
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
    }),
  );
  app.use(compression());

  // Webhooks need the RAW body for signature verification, so they are mounted
  // (with their own raw parser) BEFORE the JSON body parser. Outside the API
  // prefix → no tenant context or rate limit.
  app.use('/webhooks', express.raw({ type: '*/*' }), webhookRoutes);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(pinoHttp({ logger }));

  // Basic rate limiting on the API surface.
  app.use(
    env.API_PREFIX,
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  // Root info.
  app.get('/', (_req, res) => {
    res.json({
      name: 'NH Styx API',
      version: '0.1.0',
      docs: `${env.API_PREFIX}/health`,
    });
  });

  // Uploaded product images (served cross-origin so the web console + apps can
  // load them). Files are written under ./uploads by the upload route.
  app.use(
    '/uploads',
    express.static(UPLOAD_DIR, {
      setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
    }),
  );

  // Bind the per-request tenant (customer) context for row-level security,
  // then mount the versioned API. Must wrap the routes so the async context
  // is active for every handler/Prisma call.
  app.use(env.API_PREFIX, tenantContext);
  app.use(env.API_PREFIX, apiRoutes);

  // 404 + centralized error handling (must be last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
