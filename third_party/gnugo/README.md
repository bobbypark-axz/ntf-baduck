# GNU Go 3.8 (WebAssembly)

19×19 고급 AI가 사용하는 엔진입니다. 루트의 `gnugo-wasm.js` / `gnugo-wasm.wasm`이
이 소스에서 빌드된 산출물입니다.

- **원본:** GNU Go 3.8 — https://ftp.gnu.org/gnu/gnugo/gnugo-3.8.tar.gz
- **라이선스:** GPL-3.0-or-later (`COPYING` 참조). 이 디렉터리는 GPL 소스 제공
  의무를 위한 것으로, 원본 tarball + 아래 수정분이 전체 대응 소스입니다.
- **앱과의 결합:** 앱 본체는 wasm 모듈과 `gg_genmove_pos(보드, 턴, 패 지점, ...)`
  단일 함수 호출로만 통신합니다 (`ai-worker.js`).

## 수정 내역 (patches/)

1. `01-gg_sort-empty-array-ub.patch` — `gg_sort()`가 원소 0개 배열에서 포인터
   산술 오버플로(UB)를 일으켜 최신 컴파일러(-O1+)에서 메모리 폭주로 미스컴파일됨.
   `nel < 2`면 바로 반환하도록 가드.
2. `02-tentative-definitions-wasm.patch` — `liberty.h`가 extern 없이 배열을
   정의해 wasm 링커(common 심볼 미지원)에서 중복 정의 오류. extern 선언으로
   바꾸고 `globals.c`에 실제 정의 추가.

## 빌드 방법

```sh
# 1) 네이티브 빌드(패턴 DB .c 생성용 — mkpat 등 호스트 도구가 필요)
tar xzf gnugo-3.8.tar.gz && cd gnugo-3.8
patch -p1 < ../patches/01-gg_sort-empty-array-ub.patch
patch -p1 < ../patches/02-tentative-definitions-wasm.patch
./configure --without-readline --without-curses && make

# 2) wasm용 config.h 재생성 — 필수! 네이티브 config.h(long=8바이트)를 그대로 쓰면
#    해시 코드가 잘못 컴파일되어 깊은 수읽기에서 크래시한다(wasm32는 long=4바이트).
emconfigure ./configure --without-readline --without-curses

# 3) 래퍼와 함께 wasm 빌드 (스택 32MB — 부엉이 사활 읽기의 깊은 재귀 대비)
../build-wasm.sh
```

`gg_wrapper.c`가 wasm에서 노출하는 유일한 진입점입니다. 무상태 설계: 매 호출마다
보드를 통째로 받아 세팅하고 착수 하나를 생성합니다(웹 워커 프로토콜과 일치).
