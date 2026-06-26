/**
 * Seeds the database only when it's empty. The seed itself is mostly idempotent
 * (upserts), but this guard avoids duplicating the few non-keyed inserts on a
 * database that already has data. Used by the SessionStart hook.
 */
const { PrismaClient } = require('@prisma/client');
const { execSync } = require('node:child_process');

const prisma = new PrismaClient();

prisma.user
  .count()
  .then((n) => {
    if (n === 0) {
      console.log('Database is empty — seeding...');
      execSync('npm run db:seed', { stdio: 'inherit' });
    } else {
      console.log(`Database already has data (users=${n}) — skipping seed.`);
    }
  })
  .catch((err) => {
    // A missing table here means migrations haven't run; the hook handles that
    // separately. Don't fail the whole session over a seed check.
    console.warn('Seed check skipped:', err.message);
  })
  .finally(() => prisma.$disconnect());
