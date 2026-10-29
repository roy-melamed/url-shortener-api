/**
 * Local entrypoint — URL-7 (scaffolding).
 *
 * Runs the SAME `buildApp` instance as Lambda but via a plain Node HTTP server
 * (`listen`) against the docker-compose dev stack (design §1.2, FR-9.3, NFR-7).
 * `import 'dotenv/config'` loads the gitignored local `.env` (design §6.2) so
 * the env interface is identical to the cloud, where values are injected at
 * deploy time. Graceful shutdown closes the server on SIGINT/SIGTERM.
 */
import 'dotenv/config';
import { loadConfig } from './platform/config.js';
import { buildApp } from './app.js';

const config = loadConfig();
const app = buildApp({ config });

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info({ port: config.port }, 'server listening');
}

main().catch((error) => {
  app.log.error({ err: error }, 'failed to start server');
  process.exit(1);
});
