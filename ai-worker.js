// ai-worker.js — 고급 AI(MCTS) 계산을 메인 스레드 밖에서 돌린다.
// 큰 판은 수 초씩 계산하므로 워커가 없으면 그동안 UI(시계·애니메이션)가 멈춘다.
// 프로토콜: { id, board, turn, koKey, size, lastMove, opts } → { id, move }
importScripts("ai-engine.js");

onmessage = (event) => {
  const { id, board, turn, koKey, size, lastMove, opts } = event.data;
  const move = BadukAI.mctsSearch({ board, turn, koKey, size, lastMove }, opts);
  postMessage({ id, move });
};
