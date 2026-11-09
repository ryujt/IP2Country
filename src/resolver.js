// IP 한 건을 받아 API 응답 객체를 만든다.
import { normalizeIp, specialRangeReason } from './ip.js';

export const STATUS = {
  OK: 'ok', // 공인 IP, 국가 판별됨
  INTERNAL: 'internal', // 사설·예약 등 특수 대역 → "내부망"
  UNKNOWN: 'unknown', // 공인 IP지만 DB에 국가 정보 없음 → "국가 미상"
  INVALID: 'invalid', // IP 형식 아님
};

export function resolve(geoDb, rawIp) {
  const n = normalizeIp(rawIp);
  if (!n.ok) {
    return {
      ip: typeof rawIp === 'string' ? rawIp : null,
      status: STATUS.INVALID,
      error: n.error,
      country_code: null,
      country_name: null,
      country_name_ko: null,
    };
  }
  const base = { ip: n.ip, ip_version: n.version, ...(n.embeddedFrom ? { embedded_from: n.embeddedFrom } : {}) };
  const reason = specialRangeReason(n.ip, n.version);
  if (reason) {
    return {
      ...base,
      status: STATUS.INTERNAL,
      range: reason,
      country_code: null,
      country_name: 'Internal network',
      country_name_ko: '내부망',
    };
  }
  const c = geoDb.lookup(n.ip);
  if (!c) {
    return {
      ...base,
      status: STATUS.UNKNOWN,
      country_code: null,
      country_name: 'Unknown',
      country_name_ko: '국가 미상',
    };
  }
  return {
    ...base,
    status: STATUS.OK,
    country_code: c.code,
    country_name: c.nameEn,
    country_name_ko: c.nameKo,
  };
}
