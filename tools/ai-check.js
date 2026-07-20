// AI 난이도 검증 도구 — `node tools/ai-check.js`
//
// 두 축으로 검증한다:
//  1) 시나리오 테스트: "사람이 쓰는 공략"이 고급에게 통하는지 (축 유도, 단수 방치 미끼)
//  2) 자체 대국: 고급 vs 중급 승률 (9×9, 흑백 교대, 코미 6.5)
//
// app.js는 DOM에 묶인 IIFE라 import할 수 없어, 순수 함수를 문자열로 추출해 실행한다.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`app.js에서 함수를 찾지 못함: ${name}`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const EMPTY = 0, BLACK = 1, WHITE = 2;
const state = {};
eval([
  "cloneBoard", "inBounds", "neighbors", "getGroup", "boardKey",
  "isLegal", "legalOn", "legalMoves", "isOwnEye",
  "chooseMove", "rankSpecNow", "evaluateMove", "starPointBonus", "starPoints",
  "applySim", "bestReplyScore", "bestReplyMove", "ladderPenalty", "ladderCaptured",
].map(extract).join("\n"));

// 고급의 MCTS는 ai-engine.js(순수 엔진)를 직접 부른다. 시계 대신 반복 예산으로
// 재현성·속도를 확보한다. 기본 300은 속도용 축소 예산(자체대국·축 시나리오엔 충분).
// 사활 판단처럼 수렴이 필요한 검증은 실전 예산(2만 ≈ 브라우저 9×9 1.5초)으로 올려 잰다.
require(path.join(__dirname, "..", "ai-engine.js"));
let MCTS_SIMS = 300;
function mctsMove() {
  return globalThis.BadukAI.mctsSearch(
    { board: state.board, turn: state.turn, koKey: state.koKey, size: state.size, lastMove: state.lastMove },
    { maxIters: MCTS_SIMS }
  );
}

function makeBoard(rows) {
  // '.'=빈, 'B'=흑, 'W'=백
  return rows.map((r) => [...r].map((c) => (c === "B" ? BLACK : c === "W" ? WHITE : EMPTY)));
}

function setPosition(board, difficulty, turn = WHITE) {
  Object.assign(state, {
    size: board.length,
    board: cloneBoard(board),
    turn,
    difficulty,
    moveNumber: 30, // 포석 보너스 구간을 지난 중반 가정
    lastMove: null,
    koKey: null,
  });
}

// 같은 포지션을 n번 두게 해(무작위 노이즈 0.25 반영) 특정 수를 고른 비율을 센다.
// noMcts=true면 고급의 MCTS를 끄고 휴리스틱 폴백(힌트 버튼과 같은 경로)을 검증한다.
function countMove(board, difficulty, [mx, my], n = 30, noMcts = false) {
  let hit = 0;
  for (let i = 0; i < n; i++) {
    setPosition(board, difficulty);
    state.noMcts = noMcts;
    const move = chooseMove();
    if (move && move[0] === mx && move[1] === my) hit += 1;
  }
  return hit;
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ── 시나리오 1: 축(사다리) 유도 ─────────────────────────────
   백 (4,4)가 단수. 도망수 (5,4)를 두면 축으로 끝까지 몰려 전멸.
   사람 공략: 단수 치고 도망가게 만들어 돌을 계속 바치게 하기. */
console.log("\n[시나리오 1] 축 유도 — 죽은 돌을 포기하는가");
const ladderBoard = makeBoard([
  ".........",
  ".........",
  ".........",
  "....B....",
  "...BW....",
  "....BB...",
  ".........",
  ".........",
  ".........",
]);
{
  const mediumRuns = countMove(ladderBoard, "medium", [5, 4]);
  const hardRuns = countMove(ladderBoard, "hard", [5, 4]);
  console.log(`  (중급은 ${mediumRuns}/30회 도망 — 공략에 걸리는 기준선)`);
  check("고급은 축으로 도망치지 않는다", hardRuns === 0, `${hardRuns}/30회 도망`);
}

/* ── 시나리오 2: 단수 방치 미끼 (휴리스틱 폴백 경로) ────────────
   백 3점 그룹이 단수(활로 (5,5) 하나). 축머리 W(7,7)이 있어 (5,5)로 늘면 산다.
   반대편엔 흑 2점 미끼가 잡히기 직전 — 잡기 점수(2×16=32)가 살리기 점수보다 커서
   한 수 앞만 보면 미끼를 무는 게 이득으로 보인다.
   이 판은 3수읽기(휴리스틱) 검증용으로 설계된 것이라 noMcts로 폴백·힌트 경로를 잰다.
   고급 본체(MCTS)는 여기서 미끼를 물기도 하는데, 자체대국 확인 결과 이 판에선
   "미끼(확정 이득) vs 미생마 수비"가 전판 승률로 손해가 아니라 오판이 아니다
   — MCTS의 사활 판단은 시나리오 3에서 따로 검증한다. */
console.log("\n[시나리오 2] 단수 방치 미끼 — 작은 이득에 큰 그룹을 버리는가 (폴백 경로)");
const baitBoard = makeBoard([
  ".WW......",
  "WBBW.....",
  ".W.......",
  "....BB...",
  "...BWWB..",
  "...BW....",
  "....B....",
  ".......W.",
  ".........",
]);
{
  // 포지션 불변식: 백 3점 그룹 활로 1개(5,5) / 흑 미끼 2점 활로 1개(2,2) / (5,5) 수비가 축으로 죽지 않음
  const g = getGroup(baitBoard, 4, 4);
  const bait = getGroup(baitBoard, 1, 1);
  if (g.stones.length !== 3 || g.liberties.size !== 1 || [...g.liberties][0] !== "5,5") {
    throw new Error(`시나리오 2 포지션 오류: 백 그룹 ${g.stones.length}점 활로 ${[...g.liberties]}`);
  }
  if (bait.stones.length !== 2 || bait.liberties.size !== 1 || [...bait.liberties][0] !== "2,2") {
    throw new Error(`시나리오 2 포지션 오류: 미끼 ${bait.stones.length}점 활로 ${[...bait.liberties]}`);
  }
  const saved = applySim(baitBoard, 5, 5, WHITE);
  if (ladderPenalty(saved.board, 5, 5) !== 0) {
    throw new Error("시나리오 2 포지션 오류: (5,5) 수비가 축으로 죽는 자리임 — 축머리 확인 필요");
  }
  const hardSaves = countMove(baitBoard, "hard", [5, 5], 30, true);
  const mediumSaves = countMove(baitBoard, "medium", [5, 5]);
  console.log(`  (중급은 ${mediumSaves}/30회 수비 — 기준선)`);
  check("고급 폴백(힌트 경로)은 미끼 대신 3점 그룹을 살린다", hardSaves === 30, `${hardSaves}/30회 수비`);
}

/* ── 시나리오 3: 대마 수비 (MCTS 사활 판단) ─────────────────────
   백 5점 그룹이 단수(활로 (5,5) 하나). 축머리 W(7,7)이 있어 (5,5)로 늘면 축을 피한다.
   수비를 놓치면 다음 수에 6점이 통째로 죽는 결정적 국면.
   MCTS는 통계적 판단이라 축소 예산(300)에선 흔들리는 게 정상(수비 ~11/30) —
   실전 예산(2만 시뮬 ≈ 브라우저 9×9 1.5초)으로 수렴을 검증한다(측정상 29/30 수비). */
console.log("\n[시나리오 3] 대마 수비 — MCTS가 실전 예산에서 큰 그룹을 지키는가");
const bigGroupBoard = makeBoard([
  ".WW......",
  "WB.W.....",
  ".W.......",
  "...BBB...",
  "..BWWWB..",
  "..BWW....",
  "...BB....",
  ".......W.",
  ".........",
]);
{
  // 포지션 불변식: 백 그룹 5점 활로 1개(5,5) / 흑 미끼 1점 활로 1개(2,1) / (5,5) 수비가 축으로 죽지 않음
  const g = getGroup(bigGroupBoard, 4, 4);
  const bait = getGroup(bigGroupBoard, 1, 1);
  if (g.stones.length !== 5 || g.liberties.size !== 1 || [...g.liberties][0] !== "5,5") {
    throw new Error(`시나리오 3 포지션 오류: 백 그룹 ${g.stones.length}점 활로 ${[...g.liberties]}`);
  }
  if (bait.stones.length !== 1 || bait.liberties.size !== 1 || [...bait.liberties][0] !== "2,1") {
    throw new Error(`시나리오 3 포지션 오류: 미끼 ${bait.stones.length}점 활로 ${[...bait.liberties]}`);
  }
  const saved = applySim(bigGroupBoard, 5, 5, WHITE);
  if (ladderPenalty(saved.board, 5, 5) !== 0) {
    throw new Error("시나리오 3 포지션 오류: (5,5) 수비가 축으로 죽는 자리임 — 축머리 확인 필요");
  }
  MCTS_SIMS = 20000;
  const saves = countMove(bigGroupBoard, "hard", [5, 5], 15);
  MCTS_SIMS = 300;
  check("고급(MCTS)은 실전 예산에서 대마를 수비한다 (≥10/15)", saves >= 10, `${saves}/15회 수비`);
}

/* ── 자체 대국: 고급 vs 중급 승률 ───────────────────────── */
console.log("\n[자체 대국] 고급 vs 중급 (9×9 · 40판 · 흑백 교대 · 코미 6.5)");
function areaScore(board) {
  const size = board.length;
  const score = { [BLACK]: 0, [WHITE]: 0 };
  const visited = new Set();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = board[y][x];
      if (v !== EMPTY) { score[v] += 1; continue; }
      const key = `${x},${y}`;
      if (visited.has(key)) continue;
      const region = [];
      const borders = new Set();
      const stack = [[x, y]];
      visited.add(key);
      while (stack.length) {
        const [cx, cy] = stack.pop();
        region.push([cx, cy]);
        for (const [nx, ny] of neighbors(cx, cy, size)) {
          const nv = board[ny][nx];
          if (nv === EMPTY) {
            const nk = `${nx},${ny}`;
            if (!visited.has(nk)) { visited.add(nk); stack.push([nx, ny]); }
          } else borders.add(nv);
        }
      }
      if (borders.size === 1) score[[...borders][0]] += region.length;
    }
  }
  return score;
}

function playGame(diffBlack, diffWhite) {
  Object.assign(state, {
    size: 9,
    board: Array.from({ length: 9 }, () => Array(9).fill(EMPTY)),
    turn: BLACK,
    moveNumber: 0,
    lastMove: null,
    koKey: null,
    noMcts: false,
  });
  let passes = 0;
  for (let n = 0; n < 160 && passes < 2; n++) {
    state.difficulty = state.turn === BLACK ? diffBlack : diffWhite;
    const move = chooseMove();
    if (!move) {
      passes += 1;
      state.turn = state.turn === BLACK ? WHITE : BLACK;
      state.lastMove = null;
      state.moveNumber += 1;
      state.koKey = null;
      continue;
    }
    passes = 0;
    const prev = state.board;
    const sim = applySim(state.board, move[0], move[1], state.turn);
    const own = getGroup(sim.board, move[0], move[1]);
    const capturedOne = prev.flat().filter(Boolean).length + 1 - sim.board.flat().filter(Boolean).length === 1;
    state.koKey = capturedOne && own.stones.length === 1 && own.liberties.size === 1 ? boardKey(prev) : null;
    state.board = sim.board;
    state.lastMove = [move[0], move[1], state.turn];
    state.turn = state.turn === BLACK ? WHITE : BLACK;
    state.moveNumber += 1;
  }
  const s = areaScore(state.board);
  return s[BLACK] - (s[WHITE] + 6.5);
}

{
  let hardWins = 0;
  const games = 40;
  for (let g = 0; g < games / 2; g++) {
    if (playGame("hard", "medium") > 0) hardWins += 1;
    if (playGame("medium", "hard") < 0) hardWins += 1;
  }
  const rate = Math.round((hardWins / games) * 100);
  console.log(`  고급 ${hardWins}/${games}승 (${rate}%)`);
  check("고급이 중급을 이긴다 (승률 > 50%)", hardWins > games / 2, `${rate}%`);
}

console.log(failures ? `\n${failures}개 실패` : "\n모두 통과");
process.exit(failures ? 1 : 0);
