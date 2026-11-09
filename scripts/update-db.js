#!/usr/bin/env node
// 인터넷이 되는 반입 준비 PC에서 실행해 최신 DB-IP Country Lite MMDB를 받는다.
// 폐쇄망 운영 서버에서는 실행하지 않는다. 받은 파일을 반입 절차로 옮겨 GEO_DB_PATH 위치에 덮어쓰면
// 서버가 파일 변경을 감지해 자동으로 다시 읽는다.
//
// 사용:
//   node scripts/update-db.js                       DB-IP Country Lite(기본, CC BY 4.0) → data/dbip-country-lite.mmdb
//   node scripts/update-db.js --source sapics       sapics user-country(PDDL 1.0)       → data/user-country.mmdb
//   node scripts/update-db.js [--source ...] <출력경로>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GeoDb } from '../src/geodb.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const si = args.indexOf('--source');
const source = si === -1 ? 'dbip' : args.splice(si, 2)[1];
if (!['dbip', 'sapics'].includes(source)) {
  console.error('--source must be dbip or sapics');
  process.exit(2);
}
const defaultOut = source === 'dbip' ? 'data/dbip-country-lite.mmdb' : 'data/user-country.mmdb';
const out = path.resolve(root, args[0] ?? defaultOut);

function months() {
  const now = new Date();
  const list = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    list.push(d.toISOString().slice(0, 7));
  }
  return list;
}

async function fetchBuf(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error(`fetch failed: ${url}: ${err.cause?.code ?? err.message}`);
    return null;
  }
}

async function fromDbip() {
  for (const m of months()) {
    const url = `https://download.db-ip.com/free/dbip-country-lite-${m}.mmdb.gz`;
    const gz = await fetchBuf(url);
    if (!gz) {
      console.error(`not available yet: ${m}`);
      continue;
    }
    try {
      return { url, mmdb: zlib.gunzipSync(gz) };
    } catch {
      throw new Error('response is not gzip (blocked by a proxy?)');
    }
  }
  throw new Error('download failed');
}

async function fromSapics() {
  const url = 'https://github.com/sapics/ip-location-db/releases/download/latest/user-country.mmdb';
  const sumUrl = 'https://github.com/sapics/ip-location-db/releases/download/checksum/user-country.mmdb.sha256';
  const mmdb = await fetchBuf(url);
  const sum = await fetchBuf(sumUrl);
  if (!mmdb || !sum) throw new Error('download failed');
  const expected = sum.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash('sha256').update(mmdb).digest('hex');
  if (expected !== actual) throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);
  return { url, mmdb };
}

let got;
try {
  got = source === 'dbip' ? await fromDbip() : await fromSapics();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const { mmdb } = got;
const tmp = `${out}.tmp-${process.pid}`;
fs.mkdirSync(path.dirname(out), { recursive: true });
// 같은 디렉터리의 임시 파일에 쓰고 fsync 후 rename(원자적 교체)
const fd = fs.openSync(tmp, 'w');
fs.writeSync(fd, mmdb);
fs.fsyncSync(fd);
fs.closeSync(fd);
try {
  const db = new GeoDb(tmp); // 검증: 열리고 표본 조회가 되는지
  console.log(`validated: ${db.info.databaseType}, build ${db.info.buildDate}`);
} catch (err) {
  fs.rmSync(tmp, { force: true });
  console.error(`downloaded file is invalid: ${err.message}`);
  process.exit(1);
}
fs.renameSync(tmp, out); // 원자적 교체
const sha256 = crypto.createHash('sha256').update(mmdb).digest('hex');
fs.writeFileSync(`${out}.sha256`, `${sha256}  ${path.basename(out)}\n`);
console.log(`saved ${out} (${mmdb.length} bytes) from ${got.url}\nsha256 ${sha256}`);
