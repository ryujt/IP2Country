// MMDB 파일을 메모리에 올려 조회한다. 외부 네트워크 호출 없음.
// 여러 무료 DB의 스키마 차이를 흡수한다.
//  - DB-IP Lite / MaxMind 계열: { country: { iso_code, names: { en, ko, ... } } }
//  - IPinfo Lite / sapics ip-location-db 계열: { country_code, country }
import fs from 'node:fs';
import nodePath from 'node:path';
import { Reader } from 'mmdb-lib';

const displayNames = {
  en: new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }),
  ko: new Intl.DisplayNames(['ko'], { type: 'region', fallback: 'none' }),
};

function regionName(lang, code) {
  try {
    return displayNames[lang].of(code) ?? null;
  } catch {
    return null;
  }
}

/** DB 레코드에서 국가 코드·이름을 뽑아 공통 형태로 만든다. */
export function extractCountry(record) {
  if (!record || typeof record !== 'object') return null;
  let code = null;
  let names = {};
  // country가 없으면 registered_country(등록 국가)로 대체한다(MaxMind 계열 스키마).
  const obj = record.country?.iso_code ? record.country : record.registered_country?.iso_code ? record.registered_country : null;
  if (obj) {
    code = obj.iso_code;
    names = obj.names ?? {};
  } else if (typeof record.country_code === 'string') {
    code = record.country_code;
    if (typeof record.country === 'string') names = { en: record.country };
  }
  if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code)) return null;
  code = code.toUpperCase();
  // ZZ·XX(미상), EU·AP(지역 의사 코드), A1·A2·O1(익명 프록시 등 구 GeoIP 코드)은 국가가 아니므로 "미상"
  if (['ZZ', 'XX', 'EU', 'AP', 'A1', 'A2', 'O1'].includes(code)) return null;
  return {
    code,
    nameEn: names.en ?? regionName('en', code) ?? code,
    nameKo: names.ko ?? regionName('ko', code) ?? names.en ?? code,
  };
}

function openReader(path) {
  const buf = fs.readFileSync(path);
  const reader = new Reader(buf);
  const md = reader.metadata;
  // 열기만 하고 깨진 파일을 걸러내기 위해 표본 조회로 검증한다.
  const probeOk = ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888'].some((ip) => {
    try {
      return extractCountry(reader.get(ip)) !== null;
    } catch {
      return false;
    }
  });
  if (!probeOk) {
    throw new Error('MMDB sanity check failed: no country record for well-known public IPs');
  }
  const build = md.buildEpoch instanceof Date ? md.buildEpoch : new Date(Number(md.buildEpoch) * 1000);
  return {
    reader,
    info: {
      file: nodePath.basename(path),
      databaseType: md.databaseType,
      description: md.description?.en ?? null,
      ipVersion: md.ipVersion,
      buildDate: build.toISOString(),
      buildMonth: build.toISOString().slice(0, 7),
      fileSize: buf.length,
      loadedAt: new Date().toISOString(),
    },
  };
}

export class GeoDb {
  constructor(path) {
    this.path = path;
    this.current = openReader(path);
    this.watching = false;
  }

  get info() {
    return this.current.info;
  }

  /** @returns {{code,nameEn,nameKo}|null} */
  lookup(ip) {
    return extractCountry(this.current.reader.get(ip));
  }

  /**
   * 파일을 다시 읽어 교체한다. 새 파일이 깨졌으면 기존 DB를 유지한다.
   * @returns {{ok:true, info:object}|{ok:false, error:string}}
   */
  reload() {
    try {
      const next = openReader(this.path);
      this.current = next;
      return { ok: true, info: next.info };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** 파일 교체(mtime 변경)를 감지해 자동 재적재한다. 폐쇄망 반입 후 파일만 덮어쓰면 된다. */
  watch(onReload, intervalMs = 30_000) {
    if (this.watching) return;
    this.watching = true;
    // 변경을 감지하면 바로 읽지 않고, 다음 폴링에서 크기·mtime이 그대로일 때(복사 완료) 재적재한다.
    let pending = null;
    fs.watchFile(this.path, { interval: intervalMs, persistent: false }, (cur, prev) => {
      const sig = `${cur.mtimeMs}:${cur.size}`;
      if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) {
        pending = cur.size > 0 ? sig : null; // 변경 감지 → 안정화 대기
        return;
      }
      if (pending && pending === sig) {
        pending = null;
        const before = this.info.buildDate;
        const r = this.reload();
        onReload?.({ ...r, trigger: 'watch', previousBuildDate: before });
      }
    });
  }

  unwatch() {
    if (!this.watching) return;
    fs.unwatchFile(this.path);
    this.watching = false;
  }
}
