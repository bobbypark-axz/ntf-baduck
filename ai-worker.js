// ai-worker.js — 고급 AI 계산을 메인 스레드 밖에서 돌린다.
// 큰 판은 수 초씩 계산하므로 워커가 없으면 그동안 UI(시계·애니메이션)가 멈춘다.
// 프로토콜: { id, board, turn, koKey, size, lastMove, koPoint, opts } → { id, move }
//
// 19×19 급수 라우팅(opts.rank, 매핑은 ai-engine.js rankSpec):
//  - 15~8급: GNU Go 3.8(WASM, GPL) 레벨 1~10
//  - 7~1급: KataGo b10c128 정책망(TF.js, MIT) — 온도 샘플링으로 급수 보간
//  - rank 없음(구 프로토콜): GNU Go 레벨 10 (기존 "고급"과 동일)
// 어느 경로든 로드/실행 실패 시 한 단계씩 폴백: kata → gnugo → MCTS.
// 5·9·13줄은 기존 MCTS 유지(작은 판에선 이미 강하고 가벼움).
importScripts("ai-engine.js");

let gnugoReady = null; // { M, ptr } — 모듈과 보드 전송용 힙 버퍼(재사용)
function loadGnuGo() {
  gnugoReady ||= (async () => {
    importScripts("gnugo-wasm.js"); // createGnuGoModule 전역 등록
    const M = await createGnuGoModule();
    return { M, ptr: M._malloc(19 * 19) };
  })();
  return gnugoReady;
}

async function gnugoMove(board, turn, size, koPoint, level) {
  const { M, ptr } = await loadGnuGo();
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) M.HEAPU8[ptr + y * size + x] = board[y][x];
  }
  const enc = M._gg_genmove_pos(
    ptr, size, turn,
    koPoint ? koPoint[1] : -1, koPoint ? koPoint[0] : -1,
    65, level, (Math.random() * 1e9) | 0,
  );
  if (enc < 0) return null; // 패스(-1)·투료 판단(-2) 모두 "둘 수 없음"으로 — 앱 로직이 처리
  return [enc % 32, Math.floor(enc / 32)]; // 엔진 인코딩 i*32+j(i=행) → 앱 [x, y]
}

let kataReady = null; // KataGo 정책망 — 상위 급수 선택 시에만 지연 로드(모델 12MB)
function loadKata() {
  kataReady ||= (async () => {
    importScripts("third_party/tfjs/tf.min.js");
    importScripts("third_party/tfjs/tf-backend-wasm.min.js");
    importScripts("kata-engine.js");
    await KataEngine.init({
      wasmDir: "third_party/tfjs/",
      modelUrl: "third_party/katago/model/model.json",
    });
  })();
  return kataReady;
}

onmessage = async (event) => {
  const { id, board, turn, koKey, size, lastMove, koPoint, opts } = event.data;
  if (size === 19) {
    const spec = (opts && opts.rank && BadukAI.rankSpec(opts.rank)) || { engine: "gnugo", level: 10 };
    if (spec.engine === "kata") {
      try {
        await loadKata();
        postMessage({ id, move: await KataEngine.genmove(board, turn, koPoint, spec) });
        return;
      } catch (error) {
        // tfjs/모델 로드 실패 → GNU Go 최고 레벨로 폴백
      }
    }
    if (spec.engine === "kata" || spec.engine === "gnugo") {
      try {
        postMessage({ id, move: await gnugoMove(board, turn, size, koPoint, spec.level || 10) });
        return;
      } catch (error) {
        // wasm 로드 실패 등 → 아래 MCTS 폴백
      }
    }
  }
  const move = BadukAI.mctsSearch({ board, turn, koKey, size, lastMove }, opts);
  postMessage({ id, move });
};
