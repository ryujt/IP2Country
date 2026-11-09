// IP 문자열 정규화와 특수 대역(사설·예약) 분류.
// 공인 IP만 지오 DB에서 조회하고, 나머지는 "내부망/특수 대역"으로 분리해
// 해외 유입 통계에 섞이지 않게 한다.
import net from 'node:net';

// [대역, 접두사 길이, 분류 사유]
// 출처: IANA IPv4/IPv6 Special-Purpose Address Registry (RFC 6890 계열)
const SPECIAL_V4 = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf-protocol'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4-relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'], // 255.255.255.255(broadcast) 포함
];

const SPECIAL_V6 = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['64:ff9b:1::', 48, 'nat64-local'],
  ['100::', 64, 'discard'],
  ['2001::', 32, 'teredo'],
  ['2001:2::', 48, 'benchmarking'],
  ['2001:10::', 28, 'orchid'],
  ['2001:20::', 28, 'orchid'],
  ['2001:db8::', 32, 'documentation'],
  ['3fff::', 20, 'documentation'],
  ['5f00::', 16, 'srv6-sid'],
  ['fc00::', 7, 'private'], // ULA
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast'],
];

const blockV4 = SPECIAL_V4.map(([addr, prefix, reason]) => {
  const list = new net.BlockList();
  list.addSubnet(addr, prefix, 'ipv4');
  return { list, reason };
});
const blockV6 = SPECIAL_V6.map(([addr, prefix, reason]) => {
  const list = new net.BlockList();
  list.addSubnet(addr, prefix, 'ipv6');
  return { list, reason };
});

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** 정규화된 IPv6 문자열을 16비트 정수 8개로 펼친다. */
function expandV6(ip) {
  let s = ip;
  // 끝이 점 표기 IPv4이면 16진 2그룹으로 바꾼다.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const zeros = tail === null ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...zeros, ...t].map((x) => parseInt(x, 16));
}

const v4FromWords = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * 입력을 검증·정규화한다.
 * @returns {{ ok: true, ip: string, version: 4|6 } | { ok: false, error: string }}
 */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'IP must be a string' };
  let s = raw.trim();
  if (s.length === 0 || s.length > 64) return { ok: false, error: 'invalid IP address' };
  // [2001:db8::1] 형태 허용
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // 존 ID(fe80::1%eth0)는 지역 범위 주소에만 쓰이므로 거부한다.
  if (s.includes('%')) return { ok: false, error: 'zone index is not allowed' };
  const version = net.isIP(s);
  if (version === 0) return { ok: false, error: 'invalid IP address' };
  if (version === 6) {
    const m = MAPPED_V4.exec(s);
    if (m && net.isIPv4(m[1])) return { ok: true, ip: m[1], version: 4 };
    // 표기를 하나로 맞춘다(소문자·0 압축). URL 파서를 이용한 정규화.
    s = new URL(`http://[${s}]/`).hostname.slice(1, -1);
    // URL 파서가 매핑 주소를 16진 표기(::ffff:808:808)로 바꾸는 경우 처리
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (hex) {
      return { ok: true, ip: v4FromWords(parseInt(hex[1], 16), parseInt(hex[2], 16)), version: 4 };
    }
    // NAT64 Well-Known Prefix(64:ff9b::/96, RFC 6052): 하위 32비트가 실제 IPv4다.
    const w = expandV6(s);
    if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) {
      return { ok: true, ip: v4FromWords(w[6], w[7]), version: 4, embeddedFrom: s };
    }
    return { ok: true, ip: s, version: 6 };
  }
  return { ok: true, ip: s, version: 4 };
}

/** 특수 대역이면 사유 문자열, 공인 대역이면 null. */
export function specialRangeReason(ip, version) {
  const blocks = version === 4 ? blockV4 : blockV6;
  const type = version === 4 ? 'ipv4' : 'ipv6';
  for (const { list, reason } of blocks) {
    if (list.check(ip, type)) return reason;
  }
  if (version === 6) {
    const w = expandV6(ip);
    // 6to4(2002::/16): 비트 16~47에 든 IPv4가 사설·예약이면 내부망으로 본다.
    if (w[0] === 0x2002) {
      const inner = v4FromWords(w[1], w[2]);
      const innerReason = specialRangeReason(inner, 4);
      if (innerReason) return `6to4-${innerReason}`;
    }
    // 전역 유니캐스트(2000::/3) 밖은 공인 대역이 아니다.
    if ((w[0] & 0xe000) !== 0x2000) return 'reserved';
  }
  return null;
}
