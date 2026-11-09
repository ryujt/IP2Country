// HTTP 라우팅. 외부 프레임워크 없이 node:http만 사용한다(폐쇄망 반입 의존성 최소화).
import crypto from 'node:crypto';
import { resolve } from './resolver.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

/** DB 종류별 출처 표기(라이선스 의무). */
export function attributionFor(info = {}) {
  const t = String(info.databaseType ?? '').toLowerCase();
  const d = String(info.description ?? '').toLowerCase();
  if (d.startsWith('ip-location-db')) {
    // PDDL 1.0: 표기 의무는 없지만 출처를 남긴다.
    return { text: 'Country data from sapics/ip-location-db', url: 'https://github.com/sapics/ip-location-db', license: 'PDDL 1.0' };
  }
  if (t.startsWith('dbip')) {
    return { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com', license: 'CC BY 4.0' };
  }
  if (t.includes('ipinfo')) {
    return { text: 'IP address data powered by IPinfo', url: 'https://ipinfo.io', license: 'CC BY-SA 4.0' };
  }
  if (t.includes('ip2location')) {
    return {
      text: 'This site or product includes IP2Location LITE data available from https://lite.ip2location.com',
      url: 'https://lite.ip2location.com',
      license: 'CC BY-SA 4.0',
    };
  }
  return null;
}

function send(req, res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload), ...extraHeaders });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

function readJson(req, limitBytes) {
  return new Promise((resolveP, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      req.resume(); // 본문은 버린다
      return reject(httpError(413, 'request body too large'));
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(httpError(413, 'request body too large')); // 남은 본문은 계속 흘려보낸다
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolveP(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'invalid JSON body'));
      }
    });
    // 클라이언트가 전송 중 끊음: 서버 오류가 아니므로 499로 구분한다.
    req.on('error', () => reject(httpError(499, 'client aborted')));
  });
}

function tokenMatches(given, expected) {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** 요청 대상에서 경로와 쿼리를 분리한다. '//x/y'를 호스트로 해석하지 않도록 URL 파서에 맡기지 않는다. */
function parseTarget(target) {
  const q = target.indexOf('?');
  const rawPath = q === -1 ? target : target.slice(0, q);
  const query = new URLSearchParams(q === -1 ? '' : target.slice(q + 1));
  if (!rawPath.startsWith('/')) return null;
  const path = rawPath.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  return { path, query };
}

/**
 * @param {import('./geodb.js').GeoDb} geoDb
 * @param {{ batchMax?: number, bodyLimit?: number, adminToken?: string, log?: (o:object)=>void }} opts
 */
export function createHandler(geoDb, opts = {}) {
  const batchMax = opts.batchMax ?? 1000;
  const bodyLimit = opts.bodyLimit ?? 256 * 1024;
  const adminToken = opts.adminToken || null;
  const log = opts.log ?? (() => {});

  const commonHeaders = () => {
    const a = attributionFor(geoDb.info);
    return {
      'x-geo-db-build': geoDb.info.buildMonth,
      ...(a ? { 'x-geo-attribution': `${a.text} (${a.url})` } : {}),
    };
  };

  // 경로별 허용 메서드(405 Allow 헤더용)
  const allowFor = (path) => {
    if (path === '/v1/country/batch') return 'POST';
    if (path === '/v1/country' || path.startsWith('/v1/country/')) return 'GET, HEAD';
    if (['/v1/info', '/health', '/healthz'].includes(path)) return 'GET, HEAD';
    if (path === '/admin/reload' && adminToken) return 'POST';
    return null;
  };

  return async function handler(req, res) {
    const target = parseTarget(req.url ?? '');
    if (!target) return send(req, res, 400, { error: 'bad request target' });
    const { path, query } = target;
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    try {
      // 단건 조회: GET /v1/country/{ip}
      if (method === 'GET' && path.startsWith('/v1/country/') && path !== '/v1/country/batch') {
        let ip;
        try {
          ip = decodeURIComponent(path.slice('/v1/country/'.length));
        } catch {
          return send(req, res, 400, { error: 'bad URL encoding' });
        }
        const r = resolve(geoDb, ip);
        return send(req, res, r.status === 'invalid' ? 400 : 200, r, commonHeaders());
      }

      // 단건 조회: GET /v1/country?ip=
      if (method === 'GET' && path === '/v1/country') {
        const ip = query.get('ip');
        if (ip === null) return send(req, res, 400, { error: 'query parameter "ip" is required' });
        const r = resolve(geoDb, ip);
        return send(req, res, r.status === 'invalid' ? 400 : 200, r, commonHeaders());
      }

      // 일괄 조회: POST /v1/country/batch  { "ips": ["1.1.1.1", ...] } 또는 ["1.1.1.1", ...]
      if (method === 'POST' && path === '/v1/country/batch') {
        const body = await readJson(req, bodyLimit);
        const ips = Array.isArray(body) ? body : body?.ips;
        if (!Array.isArray(ips)) return send(req, res, 400, { error: 'body must be {"ips": [...]} or an array' });
        if (ips.length > batchMax) return send(req, res, 413, { error: `too many IPs (max ${batchMax})` });
        return send(req, res, 200, { results: ips.map((ip) => resolve(geoDb, ip)) }, commonHeaders());
      }

      // DB 정보(관리 화면에 "적용 DB 기준월" 표시용)
      if (method === 'GET' && path === '/v1/info') {
        return send(req, res, 200, {
          database: geoDb.info,
          attribution: attributionFor(geoDb.info),
          field_label_ko: '출발지 IP 기준 추정 국가',
          notes_ko: [
            'VPN·프록시를 거치면 출구 서버의 국가가 표시될 수 있습니다.',
            '사설·예약 대역은 status=internal(내부망), DB에 없는 공인 IP는 status=unknown(국가 미상)으로 구분합니다.',
          ],
        });
      }

      if (method === 'GET' && (path === '/health' || path === '/healthz')) {
        return send(req, res, 200, { status: 'ok', db_build: geoDb.info.buildMonth });
      }

      // DB 재적재: POST /admin/reload (ADMIN_TOKEN 설정 시에만 활성)
      if (method === 'POST' && path === '/admin/reload' && adminToken) {
        const auth = String(req.headers.authorization ?? '');
        if (!tokenMatches(auth, `Bearer ${adminToken}`)) return send(req, res, 401, { error: 'unauthorized' });
        const before = geoDb.info.buildDate;
        const r = geoDb.reload();
        log({ event: 'reload', trigger: 'http', previousBuildDate: before, ...r });
        return send(req, res, r.ok ? 200 : 500, r);
      }

      const allow = allowFor(path);
      if (allow) return send(req, res, 405, { error: 'method not allowed' }, { allow });
      return send(req, res, 404, { error: 'not found' });
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 499) {
        log({ event: 'client_aborted', path });
        return;
      }
      if (status >= 500) log({ event: 'error', message: err.message, stack: err.stack });
      if (res.headersSent || res.destroyed) return;
      // 본문을 끝까지 읽지 않은 경우가 있으므로 응답 후 연결을 닫는다.
      const extra = status === 413 ? { connection: 'close' } : {};
      send(req, res, status, { error: status >= 500 ? 'internal error' : err.message }, extra);
    }
  };
}
