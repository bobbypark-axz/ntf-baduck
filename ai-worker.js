// ai-worker.js — 고급 AI 계산을 메인 스레드 밖에서 돌린다.
// 큰 판은 수 초씩 계산하므로 워커가 없으면 그동안 UI(시계·애니메이션)가 멈춘다.
// 프로토콜: { id, board, turn, koKey, size, lastMove, koPoint, opts } → { id, move }
//
// 19×19 고급은 GNU Go 3.8(WASM, GPL)을 쓴다 — 순수 MCTS는 19줄 전판 운영이
// 초심자권(실측: GNU Go 최저 레벨에도 전패)이라, 검증된 엔진으로 약 8~10급을
// 확보한다. 로드/실행 실패 시(예: wasm 미지원) 기존 MCTS로 폴백.
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

async function gnugoMove(board, turn, size, koPoint) {
  const { M, ptr } = await loadGnuGo();
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) M.HEAPU8[ptr + y * size + x] = board[y][x];
  }
  const enc = M._gg_genmove_pos(
    ptr, size, turn,
    koPoint ? koPoint[1] : -1, koPoint ? koPoint[0] : -1,
    65, 10, (Math.random() * 1e9) | 0,
  );
  if (enc < 0) return null; // 패스(-1)·투료 판단(-2) 모두 "둘 수 없음"으로 — 앱 로직이 처리
  return [enc % 32, Math.floor(enc / 32)]; // 엔진 인코딩 i*32+j(i=행) → 앱 [x, y]
}

onmessage = async (event) => {
  const { id, board, turn, koKey, size, lastMove, koPoint, opts } = event.data;
  if (size === 19) {
    try {
      postMessage({ id, move: await gnugoMove(board, turn, size, koPoint) });
      return;
    } catch (error) {
      // wasm 로드 실패 등 → 아래 MCTS 폴백
    }
  }
  const move = BadukAI.mctsSearch({ board, turn, koKey, size, lastMove }, opts);
  postMessage({ id, move });
};
