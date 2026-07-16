# KataGo b10c128 신경망 (TensorFlow.js)

19×19 고급 급수(7급~1급)가 사용하는 신경망입니다. `model/`이 브라우저에서
TensorFlow.js로 구동되는 변환 산출물입니다 (정책망 단독 추론 — 탐색 없음).

- **신경망:** KataGo `kata1-b10c128-s1141046784-d204142634` (model version 8)
- **원본:** https://media.katagotraining.org/uploaded/networks/zips/kata1/kata1-b10c128-s1141046784-d204142634.zip
- **가중치 라이선스:** katagotraining.org 신경망 라이선스(MIT 계열) —
  https://katagotraining.org/network_license/ 참조. 저작권: David J Wu ("lightvector").
- **엔진/모델 코드:** KataGo (MIT) — https://github.com/lightvector/KataGo

## 변환 방법 (재현 가능)

제3자 변환본을 쓰지 않고 공식 소스에서 직접 변환했습니다:

1. 위 공식 zip의 TF 체크포인트(`saved_model/variables`)를 다운로드
2. 공식 KataGo v1.8.0 `python/model.py`로 추론 그래프 재구성
   (19×19 고정, 대칭 변환 비활성, `swa_model` 스코프) 후 체크포인트 복원 → TF saved_model 저장
3. 구글 공식 `tensorflowjs_converter`(pip)로 graph model 변환
4. `metadata.json`은 `{"version":8}` (KataGo model version — V7 입력 피처)

검증: 변환 모델과 독립 변환본(kata-model-js)의 출력이 빈 판 정책 로짓까지
일치함을 확인. 입력 인코딩은 KataGo `cpp/neuralnet/nninputs.cpp`의
`fillRowV7` 사양을 따른다 (`kata-engine.js`).

## 런타임

- `third_party/tfjs/` — TensorFlow.js 4.22.0 공식 배포본 (Apache-2.0, `LICENSE` 참조)
- 워커에서 WebGL(OffscreenCanvas) 백엔드 우선, 실패 시 WASM 백엔드 폴백
