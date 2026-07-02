import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './lib/prisma';

async function bootstrap(): Promise<void> {
  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 NH Styx API listening on http://localhost:${env.PORT}${env.API_PREFIX}`);
    logger.info(`   Environment: ${env.NODE_ENV}`);
  });

  // Serverless Postgres (Neon etc.) autosuspends when idle; the next request
  // then eats a multi-second cold start. Opt-in heartbeat keeps it awake.
  if (env.KEEP_DB_WARM) {
    const beat = setInterval(() => {
      prisma.$queryRaw`SELECT 1`.catch((err) => logger.warn({ err }, 'DB keep-warm ping failed'));
    }, 4 * 60 * 1000);
    beat.unref();
    logger.info('   DB keep-warm heartbeat active (every 4 min)');
  }

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received — shutting down gracefully...`);
    server.close(() => logger.info('HTTP server closed'));
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting');
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
