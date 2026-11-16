# 대강호: 창룡과 백조 세이브 에디터 v1.0

**The World of Kungfu: Dragon and Eagle** / **大江湖之苍龙与白鸟** 세이브 에디터입니다.  
Steam AppID `1407450` · 내부 빌드명 `TheWorldOfKongFu_Stable` · 한국어 패치 `TWOKF_KoreanPatch` 호환 · 한국어/중국어/영어 카탈로그 내장.

---

## 1. 개요

- 대상 게임: **The World of Kungfu: Dragon and Eagle** (大江湖之苍龙与白鸟)
- Steam AppID: `1407450`
- 지원 빌드: `TheWorldOfKongFu_Stable`
- 한국어 패치: `TWOKF_KoreanPatch` 호환
- 카탈로그: 한국어·중국어·영어 3개 언어 내장 (무공, 특성, 아이템, 능력치, 출신, 캐릭터, 코드 도감)
- 모든 편집은 게임 엔진 불변식을 검증한 뒤에만 저장됩니다.

---

## 2. 3가지 실행 방식 (단일 코드베이스)

### 2.1 Windows 독립 실행형 — `WorldOfKungfuSaveEditor-v1.0.exe`

- 단일 실행 파일
- 필수 구성 요소: Windows 10/11 (x64) + `.NET Framework 4.8` + `Microsoft Edge WebView2 Evergreen Runtime`
- 앱은 `WebView2` 런타임 로더를 사용합니다.
- 기본 세이브 폴더 자동 탐색: `%USERPROFILE%\Documents\TheWorldOfKongFu_Stable`
- 실행 중인 게임 프로세스(`TheWorldOfKongfu`) 감지 시 편집 차단
- 저장 시 타임스탬프 `.bak` 자동 백업 + SHA-256 무결성 검증

### 2.2 100% 오프라인 단일 HTML — `WorldOfKungfuSaveEditor-v1.0.html`

- 외부 네트워크 요청 0건 (CDN·폰트·분석 도구 없음)
- 브라우저만으로 `.dat` 열기 · 편집 · 다운로드
- 데모 세이브 체험 지원
- 파일 크기 10MB 미만, 외부 URL 스킴(`http://`, `https://`, `ftp://`, `ws://`, `wss://`, 프로토콜 상대 `//`) 미포함

### 2.3 Python 3 표준 라이브러리 CLI & 로컬 서버 — `wok_editor.py`

- 외부 패키지 의존성 0개 (표준 라이브러리만 사용)

```bash
python3 wok_editor.py inspect bigbang1data.dat
python3 wok_editor.py validate bigbang1data.dat
python3 wok_editor.py presets
python3 wok_editor.py edit bigbang1data.dat --preset rich_epiphany --output bigbang1data.edited.dat
python3 wok_editor.py edit bigbang1data.dat --arena-wins 5 --datianwangsi-level 3 --dongshu-members "1202|607" --special-wanted "sp_1|sp_2"
python3 wok_editor.py serve --port 8765
```

---

## 3. 세이브 파일 위치 및 주의사항

슬롯 세이브 (편집 대상):

```
%USERPROFILE%\Documents\TheWorldOfKongFu_Stable\bigbang1data.dat
...
%USERPROFILE%\Documents\TheWorldOfKongFu_Stable\bigbang24data.dat
```

비슬롯 파일 (같은 폴더, 편집 불가 · 안전 안내):

| 파일 | 용도 | 편집기 동작 |
| --- | --- | --- |
| `configdata.dat` | 환경설정 | 슬롯 세이브가 아니므로 한국어 안내 후 차단 |
| `StatsAndAchievementdata.dat` | 업적 | 슬롯 세이브가 아니므로 한국어 안내 후 차단 |
| `UnlockAtlasdata.dat` | 도감 | 슬롯 세이브가 아니므로 한국어 안내 후 차단 |

> 편집 전 항상 게임을 종료하고, 에디터가 생성하는 `.bak` 백업을 보관하세요.

---

## 4. 주요 편집 기능 (6개 탭 & 6종 원클릭 프리셋)

### 탭 1 — 월드
- 은량, 돈오점, 회차, 필드 이동속도, 삽 내구도
- 출신 시나리오 선택
- REA 확장 `GameData` 필드 조회·편집: 투기장 연승(`m_ArenaWinCount`), 대천왕사 층수(`m_DaTianWangSiLevel`), 군산·대천왕사 보상(`m_Arena_Rewards_JunShan` / `m_Arena_Rewards_DaTianWangSi`), 4대 문파 구성원(`m_DongShuFactionMember`, `m_JinWuFactionMember`, `m_XiBoFactionMember`, `m_BeiGuFactionMember`), 특수 현상수배(`m_SpecialWantedList`) 및 일반 현상수배(`simpleWantedInfos`) 건수 요약(원본 MessagePack 바이트 보존)

### 탭 2 — 주인공
- 성명(`12003`), 레벨, 체력, 내력, 특성점수, 호감도
- 6대 선천자질, 14종 무학조예
- 전체 `gang_a01` 능력치

### 탭 3 — 무공 & 특성
- 무공: `sz_KongFuData` + 전투 장착 + 세이브 내 자창무공 `b03append`
- 특성: `m_TraitList` + 장착 특성 9슬롯 `m_EquipTraitList`

### 탭 4 — 장비 & 가방
- 장비 3슬롯 `m_EquipSlot`
- 가방 소지품 `simplePackItems`
- 단조 장비 `b02append` / `b07append`

### 탭 5 — 동료 & 파티
- 동료 영입 `FullTeam`
- 출전 파티 `FollowList` (최대 5명)
- 월드 플래그 (`flag` 정수 플래그 & `strFlagDatas` 문자열 플래그)

### 탭 6 — 코드 도감
- REA 엔진 코드 도감 (`Assembly-CSharp.dll` 기반 9개 항목 + 키워드 검색)
  - `XmlSaver`: `COMPRESSED:` GZip+MessagePack, `RijndaelManaged`(키 `91429750903495708124650874157912`, ECB/PKCS7), `DeserializeObject`(`<?xml` vs `MessagePackSerializer`)
  - `InjuryCalManager.CalAttackDamage` / `CalBeHitInjurt`: `Style 701`(음률 `Melody`), `Style 801`(취권 `1+Drunk/25`), 내상 `saturate(Hurt/255)` 유효 내력 차감, 취중 회피 `(Drunk/100)*(1-saturate(Wineart/255))`, 방향 보정(`GetAttackSideRate`) 등 실측 전투 공식
- 공식·불변식 검증 요약

### 원클릭 프리셋 6종
- `rich_epiphany` — 은량(9,999,999)·돈오점(999)·삽 내구도(9,999) 하한 보정
- `hero_max_growth` — 주인공 레벨(60)·재능(+100, 최소 200)·기혈/내력 상한(5,000) 및 현재치 보정
- `hero_six_attributes` — 주인공 6대 선천자질(2001~2006) 영속 합산 40 이상 보정
- `hero_all_mastery` — 주인공 14종 무학조예(3001~3014) 영속 합산 220 이상 보정
- `master_all_kungfu` — 보유 무공 숙련·레벨 극대화 (대상 캐릭터의 폐기되지 않은 습득 무공 레벨 상한·숙련도 9,999 보정)
- `party_recover_boost` — 주인공·출전 동료 재능(100)·호감도(100)·보유 무공 숙련(9,999)·기혈/내력 회복·이동속도(2.25) 보정

---

## 5. 세이브 포맷 & 엔진 불변식 요약

- 저장 포맷: `COMPRESSED:` + Base64 + GZip + MessagePack
- 최상위 `GameData`는 정확히 54필드 배열
- 숫자 영속 합산은 `AtomData.get_totalValue()` 공식 사용
- 문자열 필드(성명 등)에 쉼표 `,` 사용 금지 — 구분자 보호
- 무공 제거 시 `m_KongFuListInBattle` · `m_Training_Id` 정리
- 특성 제거 시 장착 슬롯 `k|` 참조 정리
- 장비 빈 슬롯은 `"0"`으로 정규화
- 가방 중복 ID 병합, `'999'` 자리표시자 보존
- 파티 출전 인원 최대 5명
- 문자열 월드 플래그(`strFlagDatas`) 키에는 구분자 `|` · `&` 사용 금지, 정수(`flag`)·문자열 플래그 모두 빈 키 금지 및 64비트 정수 값 검증
- 장착 특성(`m_EquipTraitList`) 슬롯 범위 `1~9`, 보유 무공(`sz_KongFuData`) 5필드 CSV, 가방 비어 있지 않은 아이템 ID, `FollowList` 주인공 중복 포함 차단 검증(HTML·Python·Windows EXE 공통 적용)
- 비슬롯 `.dat`(환경설정/업적/도감)은 슬롯 세이브로 오인하지 않고 차단
- 자원 및 경로 보호: 압축 `.dat` 입력 `32 MiB` 상한 검사(브라우저 사전 파일 크기 차단 및 Python·Windows EXE 단일 검증 핸들 상한 읽기) · GZip 스트리밍 해제 `64 MiB` 상한 · MessagePack 중첩 깊이 `64` 상한 및 비확장 표준 태그 검증(HTML·Python·Windows EXE 공통) · 로컬 HTTP 서버 요청 본문 `48 MiB` 상한 및 상위 경로 이동(`..`)·심볼릭 링크·Windows 디렉터리 정션(Reparse Point)·하드링크·외부 변경(SHA-256) 차단
- 무편집 라운드트립 시 압축 해제된 내부 MessagePack 바이너리 스트림(정수·실수 태그, 맵 키 순서, 미식별 필드, 문자열 내부 선행 `U+FEFF`)은 원본과 100% 바이트 동일하게 보존되며, 외부 `.dat` 래퍼(`COMPRESSED:` + Base64 + GZip)는 표준 GZip으로 재압축됩니다(입력 시 외부 UTF-8 BOM은 허용·정규화)

---

## 6. 빌드 및 테스트 방법

```bash
python3 build.py
node tests/test_editor.cjs
python3 -B -m unittest discover -s tests -v
```

Windows 배포본 빌드:

```bash
python build.py --exe --webview2 <WebView2_SDK_폴더>
WorldOfKungfuSaveEditor-v1.0.exe --self-test <출력_폴더> [<시드_dat>]
```

실제 세이브 코퍼스 검증 (선택):

```bash
WOKSE_REAL_SAVES_DIR="/path/to/saves" node tests/test_editor.cjs
```

---

## 7. 라이선스 및 데이터 출처

- 본 프로젝트 소스 코드: **MIT License** (`LICENSE`)
- Windows 배포본(`WorldOfKungfuSaveEditor-v1.0-Windows.zip`, `WorldOfKungfuSaveEditor-v1.0.exe`)에 포함·내장되는 Microsoft Edge WebView2 SDK(`1.0.4258.31`: `Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`, `WebView2Loader.dll`)는 Microsoft의 BSD 스타일 재배포 라이선스를 따르며 `WebView2-LICENSE.txt`가 실행 파일 내부 리소스와 배포 ZIP 루트에 함께 포함됩니다.
- `src/catalog-data.js`는 플레이어 세이브 파일의 숫자 식별자를 편집 화면에서 해석하기 위한 사실적 ID-명칭·수치 상한 매핑 메타데이터(`stats`, `origins`, `characters`, `kungfu`, `traits`, `items`)만 수록하며, 게임 실행 코드·스토리 대사 스크립트·이미지·오디오 에셋을 포함하지 않습니다.
