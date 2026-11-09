import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeoDb } from '../src/geodb.js';
import { createHandler } from '../src/app.js';
import { normalizeIp, specialRangeReason } from '../src/ip.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, process.env.GEO_DB_PATH ?? 'data/dbip-country-lite.mmdb');

let server;
let base;

before(async () => {
  const db = new GeoDb(dbPath);
  server = http.createServer(createHandler(db, { batchMax: 5, adminToken: 'secret' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, headers: res.headers, body: await res.json() };
};
const post = async (p, body, headers = {}) => {
  const res = await fetch(base + p, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers });
  return { status: res.status, body: await res.json() };
};

test('normalizeIp', () => {
  assert.deepEqual(normalizeIp(' 8.8.8.8 '), { ok: true, ip: '8.8.8.8', version: 4 });
  assert.deepEqual(normalizeIp('::ffff:8.8.8.8'), { ok: true, ip: '8.8.8.8', version: 4 });
  assert.deepEqual(normalizeIp('::FFFF:808:808'), { ok: true, ip: '8.8.8.8', version: 4 });
  assert.deepEqual(normalizeIp('[2001:4860:4860:0:0:0:0:8888]'), { ok: true, ip: '2001:4860:4860::8888', version: 6 });
  for (const bad of ['', '1.2.3', '256.1.1.1', '08.8.8.8', 'abc', 'fe80::1%eth0', '1.1.1.1/24', null, 123]) {
    assert.equal(normalizeIp(bad).ok, false, String(bad));
  }
});

test('specialRangeReason', () => {
  const cases = {
    '10.1.2.3': 'private', '172.31.255.255': 'private', '192.168.0.1': 'private', '127.0.0.1': 'loopback',
    '100.64.0.1': 'cgnat', '169.254.1.1': 'link-local', '255.255.255.255': 'reserved', '0.0.0.0': 'this-network',
    '224.0.0.1': 'multicast', '203.0.113.9': 'documentation',
    '::1': 'loopback', '::': 'unspecified', 'fd00::1': 'private', 'fe80::1': 'link-local', 'ff02::1': 'multicast',
    '2001:db8::1': 'documentation',
  };
  for (const [ip, reason] of Object.entries(cases)) {
    const n = normalizeIp(ip);
    assert.equal(specialRangeReason(n.ip, n.version), reason, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860:4860::8888']) {
    const n = normalizeIp(ip);
    assert.equal(specialRangeReason(n.ip, n.version), null, ip);
  }
});

test('GET /v1/country/{ip} returns code and names', async () => {
  const r = await get('/v1/country/8.8.8.8');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.country_code, 'US');
  assert.equal(r.body.country_name, 'United States');
  assert.equal(r.body.country_name_ko, '미국');
  assert.match(r.headers.get('x-geo-attribution') ?? '', /DB-IP/);
});

test('Korean IP and IPv6', async () => {
  const kr = await get('/v1/country?ip=211.234.10.1');
  assert.equal(kr.body.country_code, 'KR');
  assert.equal(kr.body.country_name_ko, '대한민국');
  const v6 = await get(`/v1/country/${encodeURIComponent('2001:4860:4860::8888')}`);
  assert.equal(v6.status, 200);
  assert.equal(v6.body.status, 'ok');
  assert.match(v6.body.country_code, /^[A-Z]{2}$/);
});

test('private IP → internal, invalid → 400', async () => {
  const p = await get('/v1/country/192.168.1.10');
  assert.equal(p.body.status, 'internal');
  assert.equal(p.body.country_code, null);
  assert.equal(p.body.country_name_ko, '내부망');
  const bad = await get('/v1/country/not-an-ip');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.status, 'invalid');
  const missing = await get('/v1/country');
  assert.equal(missing.status, 400);
  const badEnc = await get('/v1/country/%E0%A4%A');
  assert.equal(badEnc.status, 400);
});

test('batch', async () => {
  const r = await post('/v1/country/batch', { ips: ['8.8.8.8', '10.0.0.1', 'x', '::ffff:1.1.1.1'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.status), ['ok', 'internal', 'invalid', 'ok']);
  assert.equal(r.body.results[3].ip, '1.1.1.1');
  assert.equal((await post('/v1/country/batch', { ips: Array(6).fill('1.1.1.1') })).status, 413);
  assert.equal((await post('/v1/country/batch', '{bad')).status, 400);
  assert.equal((await post('/v1/country/batch', { nope: 1 })).status, 400);
});

test('info, health, 404/405, admin reload', async () => {
  const info = await get('/v1/info');
  assert.match(info.body.database.buildMonth, /^\d{4}-\d{2}$/);
  assert.equal(info.body.attribution.text, 'IP Geolocation by DB-IP');
  assert.equal((await get('/health')).body.status, 'ok');
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await post('/v1/info', {})).status, 405);
  assert.equal((await post('/admin/reload', {})).status, 401);
  const ok = await post('/admin/reload', {}, { authorization: 'Bearer secret' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
});

test('NAT64 / 6to4 embedded IPv4', async () => {
  const nat = await get(`/v1/country/${encodeURIComponent('64:ff9b::8.8.8.8')}`);
  assert.equal(nat.body.status, 'ok');
  assert.equal(nat.body.ip, '8.8.8.8');
  assert.equal(nat.body.country_code, 'US');
  assert.equal(nat.body.embedded_from, '64:ff9b::808:808');
  const natPriv = await get(`/v1/country/${encodeURIComponent('64:ff9b::10.0.0.1')}`);
  assert.equal(natPriv.body.range, 'private');
  const sixToFour = await get(`/v1/country/${encodeURIComponent('2002:c0a8:101::1')}`);
  assert.equal(sixToFour.body.status, 'internal');
  assert.equal(sixToFour.body.range, '6to4-private');
});

test('path handling, HEAD, Allow', async () => {
  assert.equal((await get('//v1/country/8.8.8.8')).body.country_code, 'US');
  assert.equal((await get('//x/v1/info')).status, 404);
  const head = await fetch(`${base}/v1/country/8.8.8.8`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  const r = await fetch(`${base}/v1/country/batch`);
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'POST');
});

test('oversized body gets a real 413', async () => {
  const big = JSON.stringify({ ips: Array(40000).fill('255.255.255.255') }); // > 256KB
  const r = await fetch(`${base}/v1/country/batch`, { method: 'POST', body: big });
  assert.equal(r.status, 413);
});

test('extractCountry pseudo codes and registered_country fallback', async () => {
  const { extractCountry } = await import('../src/geodb.js');
  assert.equal(extractCountry({ country: { iso_code: 'EU' } }), null);
  assert.equal(extractCountry({ registered_country: { iso_code: 'KR' } }).nameKo, '대한민국');
  assert.deepEqual(extractCountry({ country_code: 'jp', country: 'Japan' }), { code: 'JP', nameEn: 'Japan', nameKo: '일본' });
});
