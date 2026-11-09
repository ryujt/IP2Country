// 진입점. 환경 변수:
//   PORT(기본 8080), HOST(기본 0.0.0.0), GEO_DB_PATH(기본 data/dbip-country-lite.mmdb)
//   BATCH_MAX(기본 1000), ADMIN_TOKEN(설정 시 POST /admin/reload 활성)
//   DB_WATCH_INTERVAL_MS(기본 30000, 0이면 파일 감시 끔)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeoDb } from './geodb.js';
import { createHandler } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const dbPath = path.resolve(root, env.GEO_DB_PATH ?? 'data/dbip-country-lite.mmdb');
const port = Number(env.PORT ?? 8080);
const host = env.HOST ?? '0.0.0.0';
const watchInterval = Number(env.DB_WATCH_INTERVAL_MS ?? 30_000);

const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

let geoDb;
try {
  geoDb = new GeoDb(dbPath);
} catch (err) {
  log({ event: 'fatal', message: `cannot load GeoIP DB at ${dbPath}: ${err.message}` });
  process.exit(1);
}
log({ event: 'db_loaded', ...geoDb.info });

const onReload = (r) => log({ event: 'reload', ...(r.ok ? { ok: true, ...r.info } : r) });
if (watchInterval > 0) geoDb.watch(onReload, watchInterval);
process.on('SIGHUP', () => onReload(geoDb.reload()));

const server = http.createServer(
  createHandler(geoDb, {
    batchMax: Number(env.BATCH_MAX ?? 1000),
    adminToken: env.ADMIN_TOKEN,
    log,
  }),
);
server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 5_000;

server.on('error', (err) => {
  log({ event: 'fatal', message: `server error: ${err.code ?? ''} ${err.message}` });
  process.exit(1);
});
server.listen(port, host, () => log({ event: 'listening', host, port }));

const shutdown = (sig) => {
  log({ event: 'shutdown', signal: sig });
  geoDb.unwatch();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
