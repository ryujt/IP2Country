# Third-Party Notices

이 제품에는 아래 제3자 데이터와 소프트웨어가 포함되어 있습니다.

## IP to Country Lite (DB-IP) — 기본 동봉 데이터

- 파일: `data/dbip-country-lite.mmdb`
- 출처: IP to Country Lite database by DB-IP.com — https://db-ip.com
- 라이선스: Creative Commons Attribution 4.0 International (CC BY 4.0) — https://creativecommons.org/licenses/by/4.0/
- 변경 사항: 없음. 공급자가 배포한 MMDB 파일을 그대로 동봉합니다. 국가명 보완(한국어·영어)은 조회 시점에 별도로 붙이며 DB 파일을 수정하지 않습니다.
- 보증: 데이터는 "있는 그대로(as is)" 제공되며 정확성을 보증하지 않습니다.
- 표시 의무: 국가 조회 결과를 표시하거나 사용하는 화면에 다음 링크를 둡니다.

  ```html
  <a href="https://db-ip.com">IP Geolocation by DB-IP</a>
  ```

- CC BY 4.0 §2(a)(5)(B)에 따라 동봉된 DB 파일에는 추가 이용 제한이나 기술적 보호 조치를 적용하지 않습니다. 제품 EULA보다 이 데이터의 CC BY 4.0 조건이 우선합니다.

## ip-location-db user-country (sapics) — 선택형 대체 데이터

`scripts/update-db.js --source sapics`로 받아 `GEO_DB_PATH`로 지정한 경우에만 해당합니다.

- 출처: https://github.com/sapics/ip-location-db (user-country)
- 라이선스: Open Data Commons Public Domain Dedication and License (PDDL) 1.0 — https://opendatacommons.org/licenses/pddl/1-0/
- 참고: 원천 데이터(RIR 통계, BGP, geofeed)는 "있는 그대로" 제공됩니다. 원천 데이터의 권리 관계는 공급자가 보증하지 않습니다.

## mmdb-lib 3.0.4

- 출처: https://github.com/runk/mmdb-lib
- 라이선스: MIT License

## Node.js 런타임의 ICU/CLDR 데이터

DB에 국가명이 없을 때 Node.js에 내장된 `Intl.DisplayNames`(ICU/CLDR 데이터)로 국가명을 만듭니다. 해당 데이터는 Node.js 배포물에 포함된 Unicode License v3를 따릅니다. https://www.unicode.org/license.txt
