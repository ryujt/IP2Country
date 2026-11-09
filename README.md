# IP2Country

IP 주소를 받아 국가 코드(ISO 3166-1 alpha-2)와 국가명(영어·한국어)을 돌려주는 API 서버입니다.
국가 DB(MMDB)를 제품에 동봉하고 로컬에서만 조회하므로 **폐쇄망에서 외부 통신 없이** 동작합니다.

- IPv4·IPv6 지원(IPv4-mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96` 포함)
- 사설·예약 대역은 `internal`(내부망), DB에 없는 공인 IP는 `unknown`(국가 미상)으로 구분해 해외 유입 통계에 섞이지 않게 함
- DB 파일을 덮어쓰면 서버를 재시작하지 않고 자동으로 다시 읽음
- 런타임 의존성: `mmdb-lib` 1개

## 빠른 시작

Node.js 20 이상이 필요합니다(Node.js 26.12에서 확인).

```bash
npm ci
npm start                     # 기본 0.0.0.0:8080
curl localhost:8080/v1/country/211.234.10.1
```

```json
{"ip":"211.234.10.1","ip_version":4,"status":"ok","country_code":"KR","country_name":"South Korea","country_name_ko":"대한민국"}
```

### Docker로 배포

```bash
docker compose up -d --build        # http://localhost:8095 (IP2COUNTRY_PORT로 변경)
docker compose ps                   # STATUS가 healthy인지 확인
docker compose logs -f              # JSON 로그
```

[docker-compose.yml](docker-compose.yml)은 `./data`를 읽기 전용으로 마운트합니다. 그래서 `data/`의 DB만 교체해도 재빌드 없이 반영됩니다.

이미지에는 의존성과 DB가 모두 들어 있어 폐쇄망 반입에도 쓸 수 있습니다.

```bash
docker save ip2country:1.0.0 | gzip > ip2country-1.0.0.tar.gz   # 반입 후 docker load -i
docker run -d --name ip2country -p 8095:8080 --restart unless-stopped ip2country:1.0.0
```

이미지는 빌드한 PC의 아키텍처로 만들어집니다. 반입 대상 서버가 x86_64이면 `docker build --platform linux/amd64 -t ip2country:1.0.0 .`로 빌드하십시오.

## API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/v1/country/{ip}` | 단건 조회. IPv6는 그대로 넣거나 URL 인코딩 |
| GET | `/v1/country?ip={ip}` | 단건 조회(쿼리 방식) |
| POST | `/v1/country/batch` | 일괄 조회. 본문 `{"ips": ["8.8.8.8", ...]}` 또는 배열. 최대 `BATCH_MAX`건 |
| GET | `/v1/info` | 적용 중인 DB 종류·기준월·출처 표기 문구 |
| GET | `/health` | 헬스체크 |
| POST | `/admin/reload` | DB 즉시 재적재. `ADMIN_TOKEN` 설정 시에만 활성, `Authorization: Bearer <토큰>` |

응답의 `status` 값:

| status | 의미 | country_code | country_name_ko |
| --- | --- | --- | --- |
| `ok` | 공인 IP, 국가 판별 | `KR` 등 | `대한민국` 등 |
| `internal` | 사설·루프백·CGNAT·문서용 등 특수 대역(`range`에 사유) | `null` | `내부망` |
| `unknown` | 공인 IP지만 DB에 국가 정보 없음 | `null` | `국가 미상` |
| `invalid` | IP 형식 아님(HTTP 400, 일괄 조회에서는 항목별로 표시) | `null` | `null` |

모든 조회 응답에는 `X-Geo-Db-Build`(DB 기준월)와 `X-Geo-Attribution`(출처) 헤더가 붙습니다.

### curl 예제

아래 출력은 2026-11 DB로 실제 실행한 결과입니다. `npm start`로 띄웠다면 포트를 `8080`으로 바꾸십시오.

```bash
B=http://localhost:8095
```

**단건 조회(경로 방식)**

```bash
curl -s $B/v1/country/8.8.8.8
```
```json
{"ip":"8.8.8.8","ip_version":4,"status":"ok","country_code":"US","country_name":"United States","country_name_ko":"미국"}
```

**단건 조회(쿼리 방식)**

```bash
curl -s "$B/v1/country?ip=1.1.1.1"
```
```json
{"ip":"1.1.1.1","ip_version":4,"status":"ok","country_code":"AU","country_name":"Australia","country_name_ko":"오스트레일리아"}
```

**IPv6와 IPv4-mapped 주소**(매핑 주소는 IPv4로 정규화)

```bash
curl -s "$B/v1/country/2001:4860:4860::8888"
curl -s "$B/v1/country/%3A%3Affff%3A8.8.4.4"      # ::ffff:8.8.4.4
```
```json
{"ip":"2001:4860:4860::8888","ip_version":6,"status":"ok","country_code":"CA","country_name":"Canada","country_name_ko":"캐나다"}
{"ip":"8.8.4.4","ip_version":4,"status":"ok","country_code":"US","country_name":"United States","country_name_ko":"미국"}
```

**사설 IP → 내부망**

```bash
curl -s $B/v1/country/192.168.0.10
```
```json
{"ip":"192.168.0.10","ip_version":4,"status":"internal","range":"private","country_code":null,"country_name":"Internal network","country_name_ko":"내부망"}
```

**잘못된 IP → HTTP 400**

```bash
curl -s -w ' HTTP %{http_code}\n' $B/v1/country/999.1.1.1
```
```
{"ip":"999.1.1.1","status":"invalid","error":"invalid IP address","country_code":null,"country_name":null,"country_name_ko":null} HTTP 400
```

**일괄 조회**(NAT64 주소 `64:ff9b::/96`은 내장된 IPv4로 조회하고 원래 주소를 `embedded_from`에 남김)

```bash
curl -s -X POST $B/v1/country/batch \
  -H 'content-type: application/json' \
  -d '{"ips":["211.234.10.1","8.8.8.8","10.0.0.1","64:ff9b::1.1.1.1"]}'
```
```json
{"results":[
  {"ip":"211.234.10.1","ip_version":4,"status":"ok","country_code":"KR","country_name":"South Korea","country_name_ko":"대한민국"},
  {"ip":"8.8.8.8","ip_version":4,"status":"ok","country_code":"US","country_name":"United States","country_name_ko":"미국"},
  {"ip":"10.0.0.1","ip_version":4,"status":"internal","range":"private","country_code":null,"country_name":"Internal network","country_name_ko":"내부망"},
  {"ip":"1.1.1.1","ip_version":4,"embedded_from":"64:ff9b::101:101","status":"ok","country_code":"AU","country_name":"Australia","country_name_ko":"오스트레일리아"}
]}
```

**응답 헤더(DB 기준월·출처)**

```bash
curl -s -D - -o /dev/null $B/v1/country/8.8.8.8 | grep -i x-geo
```
```
x-geo-db-build: 2026-11
x-geo-attribution: IP Geolocation by DB-IP (https://db-ip.com)
```

**DB 정보와 헬스체크**

```bash
curl -s $B/v1/info
curl -s $B/health
```
```json
{"database":{"file":"dbip-country-lite.mmdb","databaseType":"DBIP-Country-Lite","description":"DB-IP.com - IP to Country","ipVersion":6,"buildDate":"2026-11-01T02:47:39.000Z","buildMonth":"2026-11","fileSize":8515063,"loadedAt":"..."},"attribution":{"text":"IP Geolocation by DB-IP","url":"https://db-ip.com","license":"CC BY 4.0"},"field_label_ko":"출발지 IP 기준 추정 국가","notes_ko":["..."]}
{"status":"ok","db_build":"2026-11"}
```

**DB 즉시 재적재**(`ADMIN_TOKEN` 설정 시. 설정하지 않으면 404)

```bash
curl -s -X POST $B/admin/reload -H "Authorization: Bearer $ADMIN_TOKEN"
```

## 데이터와 라이선스

기본 동봉 데이터는 **DB-IP IP to Country Lite**(CC BY 4.0, 월간 갱신)입니다. 공급자 FAQ가 상업 이용과 재배포를 허용하고, 한국어 국가명이 들어 있습니다.

2026-11-09에 무료 IP→국가 DB들을 비교했습니다. 요약은 다음과 같습니다.

| 데이터 | 라이선스 | 판단 |
| --- | --- | --- |
| DB-IP Country Lite | CC BY 4.0, 출처 표시 필요 | **기본값**. 재배포 근거가 가장 명확함 |
| sapics `user-country` | PDDL 1.0, 출처 표시 의무 없음 | **대체 DB로 지원**. GeoLite2 대비 일치율은 더 높지만(IPv4 97.5% 대 94.5%, 공급자 측정), 1인 운영이고 원천 데이터(RIPE NCC 통계 등)의 상업 재배포 권리를 공급자가 보증하지 않음 |
| IPinfo Lite | CC BY-SA 4.0 | 계정 필요, 외부 상업 이용은 별도 계약 대상으로 봄 |
| IP2Location LITE | CC BY-SA 4.0 + 자체 약관 | MMDB 재배포 불가 |
| MaxMind GeoLite2 | 자체 EULA | 재배포·구버전 파기 조건 때문에 부적합 |
| sapics `geo-whois-asn-country`(CC0) | — | 2026-06 폐지 |

고객사가 화면 출처 표시를 받아들이지 않으면 대체 DB로 바꿀 수 있습니다. 이 경우 원천 데이터 권리에 대한 법무 검토를 먼저 받으십시오.

```bash
node scripts/update-db.js --source sapics          # data/user-country.mmdb (SHA-256 검증)
GEO_DB_PATH=data/user-country.mmdb npm start
```

**DB-IP 사용 시 의무**: 국가 결과를 보여주는 화면에 `<a href="https://db-ip.com">IP Geolocation by DB-IP</a>`를 표시하고, 제품 고지 문서에 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 내용을 포함합니다. 폐쇄망이라 링크가 열리지 않아도 문구와 URL은 표시합니다.

화면 항목명은 **“출발지 IP 기준 추정 국가”**를 권합니다. VPN·프록시를 거치면 출구 서버의 국가가 나옵니다.

## 운영

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 수신 주소 |
| `GEO_DB_PATH` | `data/dbip-country-lite.mmdb` | MMDB 경로(프로젝트 루트 기준 상대 경로 가능) |
| `BATCH_MAX` | `1000` | 일괄 조회 최대 건수(본문은 256KB 제한) |
| `DB_WATCH_INTERVAL_MS` | `30000` | DB 파일 변경 감시 주기, `0`이면 끔 |
| `ADMIN_TOKEN` | 없음 | 설정 시 `POST /admin/reload` 활성 |

**DB 갱신 절차(월 1회 권장)**

1. 인터넷이 되는 반입 준비 PC에서 `npm run update-db`를 실행합니다. 최신 월 파일을 받아 검증하고 `data/dbip-country-lite.mmdb`와 `.sha256`을 만듭니다.
2. 기관 반입 절차로 두 파일을 옮기고 `shasum -a 256 -c dbip-country-lite.mmdb.sha256`으로 확인합니다.
3. 운영 서버의 DB와 **같은 디렉터리에 임시 이름으로 복사한 뒤 `mv`로 교체**합니다. 서버가 변경을 감지해 크기·수정 시각이 안정되면 다시 읽습니다. 새 파일이 깨졌으면 기존 DB를 계속 씁니다. 즉시 반영하려면 `kill -HUP <pid>` 또는 `POST /admin/reload`를 씁니다.
4. `GET /v1/info`의 `buildMonth`로 반영을 확인합니다. 관리자 화면에는 이 값을 “적용 DB 기준월”로 표시하십시오.

Docker에서 DB만 교체하려면 파일 하나가 아니라 **디렉터리**를 마운트합니다(`-v /opt/geo:/app/data`). 파일 단위 bind mount는 `mv` 교체를 컨테이너가 보지 못합니다.

로그는 표준 출력에 JSON 한 줄씩 남습니다(`db_loaded`, `reload`, `error` 등).

## 개발과 검증

| 파일 | 책임 |
| --- | --- |
| [src/ip.js](src/ip.js) | IP 검증·정규화, 특수 대역 분류(IANA Special-Purpose Registry 기준) |
| [src/geodb.js](src/geodb.js) | MMDB 적재·재적재·파일 감시, DB별 스키마 차이 흡수, 국가명 보완 |
| [src/resolver.js](src/resolver.js) | IP 한 건 → 응답 객체 |
| [src/app.js](src/app.js) | HTTP 라우팅, 본문 제한, 출처 표기 |
| [src/server.js](src/server.js) | 진입점, 환경 변수, 시그널 처리 |
| [scripts/update-db.js](scripts/update-db.js) | DB 다운로드·검증·원자적 교체(인터넷 환경 전용) |

```bash
npm test     # node:test, 동봉 DB로 API·분류·경계 조건 11개 테스트
```

## 제약

- 국가 판별은 IP 대역 등록·라우팅 정보에 기반한 추정입니다. 위치 정확도를 보증하지 않습니다.
- Teredo(`2001::/32`)는 내부망으로 분류합니다. 내장된 클라이언트 IPv4로 조회하지 않습니다.
- 인증은 관리용 재적재 API에만 있습니다. 조회 API는 내부망에 두고, 외부에 노출할 때는 앞단에서 접근을 제한하십시오.
