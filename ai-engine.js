// ai-engine.js — 고급 AI(MCTS) 순수 엔진. DOM/앱 상태에 묶이지 않는다.
// 세 환경에서 같은 파일을 쓴다:
//  - 브라우저 메인 스레드: <script src="ai-engine.js"> (워커 실패 시 동기 폴백)
//  - Web Worker: importScripts("ai-engine.js") — 평소 계산은 여기서 돈다
//  - Node: require("./ai-engine.js") — tools/ai-check.js 자체대국 검증
// 진입점: globalThis.BadukAI.mctsSearch(pos, opts)
//   pos  = { board(2차원 배열), turn, koKey, size }
//   opts = { budgetMs(시간 예산), maxIters(반복 예산 — 검증용, 있으면 시계 무시),
//            priors(휴리스틱 사전지식 주입, 기본 on), restrict(큰 판 후보 제한, 기본 on),
//            rave(RAVE/AMAF 통계 공유, 기본 on) }
// 알고리즘: UCT 몬테카를로 트리 탐색 + RAVE.
//  - 판을 끝까지 둬 보고 실제 집을 세므로 점수표와 달리 집·사활·판세를 스스로 읽는다.
//  - 큰 판(13·19) 대응 강화: ① 후보를 "돌 근처 2칸 + 화점"으로 좁혀 분기 축소
//    ② 잡기/살리기/근접 같은 값싼 휴리스틱을 가상 방문(prior)으로 심어 유망수부터 탐색
//    ③ RAVE: "시뮬레이션 어딘가에서 그 자리에 둔 대국의 승률"(AMAF)을 형제 수끼리
//       공유해, 방문이 적은 초기에도 유망수를 빨리 골라낸다(큰 판일수록 효과 큼).
(() => {
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const komiFor = (size) => (size === 5 ? 0.5 : 6.5);
  const MCTS_MAX_ITERS = 40000;
  const UCT_C = 1.4;
  const RAVE_C = 0.5; // RAVE가 탐색을 이끌 땐 UCT 탐사항을 줄인다(MoGo 계열 관례)
  const RAVE_K = 1000; // 방문이 이 규모를 넘으면 RAVE 대신 실측 승률을 믿는다
  const PRIOR_N = 8; // prior를 몇 번의 가상 방문으로 칠지

  function otherColor(c) { return c === BLACK ? WHITE : BLACK; }

  function cloneBoard(board) {
    return board.map((row) => row.slice());
  }

  function neighbors(x, y, size) {
    const out = [];
    if (x > 0) out.push([x - 1, y]);
    if (x < size - 1) out.push([x + 1, y]);
    if (y > 0) out.push([x, y - 1]);
    if (y < size - 1) out.push([x, y + 1]);
    return out;
  }

  function getGroup(board, x, y) {
    const color = board[y][x];
    if (!color) return { stones: [], liberties: new Set() };
    const visited = new Set();
    const liberties = new Set();
    const stones = [];
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      const key = `${cx},${cy}`;
      if (visited.has(key)) continue;
      visited.add(key);
      stones.push([cx, cy]);
      for (const [nx, ny] of neighbors(cx, cy, board.length)) {
        const value = board[ny][nx];
        if (value === EMPTY) liberties.add(`${nx},${ny}`);
        else if (value === color && !visited.has(`${nx},${ny}`)) stack.push([nx, ny]);
      }
    }
    return { stones, liberties };
  }

  function boardKey(board) {
    return board.map((row) => row.join("")).join("");
  }

  // 가상 착수: 잡히는 상대 돌을 들어낸 보드를 돌려준다. 자살수면 null.
  function applySim(board, x, y, color) {
    if (board[y][x] !== EMPTY) return null;
    const size = board.length;
    const opp = color === BLACK ? WHITE : BLACK;
    const next = cloneBoard(board);
    next[y][x] = color;
    let captured = 0;
    for (const [nx, ny] of neighbors(x, y, size)) {
      if (next[ny][nx] !== opp) continue;
      const group = getGroup(next, nx, ny);
      if (group.liberties.size === 0) {
        captured += group.stones.length;
        for (const [sx, sy] of group.stones) next[sy][sx] = EMPTY;
      }
    }
    if (getGroup(next, x, y).liberties.size === 0) return null;
    return { board: next, captured };
  }

  function starPoints(size) {
    if (size === 5) return [[2, 2]];
    if (size === 9) return [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]];
    if (size === 13) return [[3, 3], [9, 3], [6, 6], [3, 9], [9, 9]];
    return [[3, 3], [9, 3], [15, 3], [3, 9], [9, 9], [15, 9], [3, 15], [9, 15], [15, 15]];
  }

  // (x,y)가 color의 눈인가: 상하좌우가 모두 내 돌이거나 판 밖.
  // 자기 눈을 메우지 않아야 플레이아웃이 실제 집을 남기고 끝난다.
  function isEyeFor(board, x, y, color, size) {
    for (const [nx, ny] of neighbors(x, y, size)) {
      if (board[ny][nx] !== color) return false;
    }
    return true;
  }

  // 착수 뒤의 패(劫) 금지 키: 단 1점을 따내 스스로도 단수 1점이 되는 경우만.
  function koKeyAfter(before, after, captured, x, y) {
    if (captured !== 1) return null;
    const g = getGroup(after, x, y);
    return g.stones.length === 1 && g.liberties.size === 1 ? boardKey(before) : null;
  }

  // 값싼 합법성 판정: 빈 이웃이 하나라도 있으면 활로가 보장돼 자살수·패가 아니다.
  // 완전히 둘러싸인 점(따냄/자살·패 가능)만 실제로 두어보며 확인한다.
  function cheapLegal(board, x, y, color, size, koKey) {
    for (const [nx, ny] of neighbors(x, y, size)) {
      if (board[ny][nx] === EMPTY) return true;
    }
    const sim = applySim(board, x, y, color);
    if (!sim) return false;
    if (koKey && boardKey(sim.board) === koKey) return false;
    return true;
  }

  // ── 축(사다리) 읽기 ─────────────────────────────────────────
  // 무작위 플레이아웃은 십수 수짜리 외길 추격을 이어가지 못해 "축으로 도망쳐도
  // 산다"고 착각한다(MCTS의 고전적 약점). 루트 후보에서만 기존 축 읽기를 빌려
  // 도주수를 잘라낸다. 방금 둔 (x,y) 그룹이 활로 2개이고 축으로 끝까지 잡히면 true.
  function ladderDoomed(board, x, y) {
    const color = board[y][x];
    const opp = color === BLACK ? WHITE : BLACK;
    const own = getGroup(board, x, y);
    if (own.liberties.size !== 2) return false;
    for (const key of own.liberties) {
      const [ax, ay] = key.split(",").map(Number);
      const chase = applySim(board, ax, ay, opp);
      if (!chase) continue;
      if (getGroup(chase.board, ax, ay).liberties.size <= 1) continue;
      if (getGroup(chase.board, x, y).liberties.size === 1 && ladderCaptured(chase.board, x, y, 0)) return true;
    }
    return false;
  }

  // 축 읽기: 단수에 몰린 (gx,gy) 그룹이 도망쳐도 결국 잡히면 true.
  // 노드 예산: 도망자 활로가 2개면 양쪽 추격을 모두 재귀하므로 최악 2^40으로
  // 폭발한다(실전에서 드물게 걸려 수 분씩 멈춤). 호출당 총 노드 수를 제한하고,
  // 초과하면 "안 잡힌다"로 안전하게 후퇴한다(수를 버리는 쪽보다 남기는 쪽이 무해).
  function ladderCaptured(board, gx, gy, depth) {
    if (depth === 0) ladderCaptured.nodes = 0;
    ladderCaptured.nodes += 1;
    if (depth > 40 || ladderCaptured.nodes > 500) return false;
    const color = board[gy][gx];
    const opp = color === BLACK ? WHITE : BLACK;
    const group = getGroup(board, gx, gy);
    if (group.liberties.size === 0) return true;
    if (group.liberties.size >= 2) return false;
    const [lx, ly] = [...group.liberties][0].split(",").map(Number);
    const run = applySim(board, lx, ly, color);
    if (!run) return true;
    const after = getGroup(run.board, lx, ly);
    if (after.liberties.size >= 3 || (run.captured > 0 && after.liberties.size >= 2)) return false;
    if (after.liberties.size <= 1) return true;
    for (const key of after.liberties) {
      const [ax, ay] = key.split(",").map(Number);
      const chase = applySim(run.board, ax, ay, opp);
      if (!chase) continue;
      if (getGroup(chase.board, ax, ay).liberties.size <= 1) continue;
      if (getGroup(chase.board, lx, ly).liberties.size === 1 && ladderCaptured(chase.board, lx, ly, depth + 1)) return true;
    }
    return false;
  }

  // ── 후보 제한(큰 판) ────────────────────────────────────────
  // 19×19에서 빈 자리 전부(300+)를 후보로 삼으면 탐색이 얕게 퍼져 무의미해진다.
  // "기존 돌의 체비셰프 2칸 이내 + 화점(큰 자리)"으로 좁힌다. 빈 판이면 화점만 남는다.
  function allowedMask(board, size) {
    if (size < 13) return null;
    const mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (board[y][x] === EMPTY) continue;
        const x0 = Math.max(0, x - 2);
        const x1 = Math.min(size - 1, x + 2);
        const y0 = Math.max(0, y - 2);
        const y1 = Math.min(size - 1, y + 2);
        for (let yy = y0; yy <= y1; yy += 1) {
          for (let xx = x0; xx <= x1; xx += 1) mask[yy * size + xx] = 1;
        }
      }
    }
    for (const [sx, sy] of starPoints(size)) mask[sy * size + sx] = 1;
    return mask;
  }

  // color가 둘 수 있는 자리(자기 눈·자살수·패 제외, 큰 판은 mask로 제한).
  function genMoves(board, color, size, koKey, mask) {
    const moves = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (board[y][x] !== EMPTY) continue;
        if (mask && !mask[y * size + x]) continue;
        if (isEyeFor(board, x, y, color, size)) continue;
        if (cheapLegal(board, x, y, color, size, koKey)) moves.push([x, y]);
      }
    }
    // 제한 때문에 후보가 사라졌으면(드묾: 돌 근처가 전부 메워진 종반) 제한 없이 재시도
    if (!moves.length && mask) return genMoves(board, color, size, koKey, null);
    return moves;
  }

  // ── 사전지식(prior) ─────────────────────────────────────────
  // 무작위 탐색이 유망수를 찾기 전에 "잡기/살리기/단수/근접/포석" 같은 값싼 휴리스틱을
  // 가상 방문으로 심어, 탐색이 유망수부터 파고들게 한다. 보드당 그룹 스캔 1회(O(N)).
  function computePriors(board, moves, color, size, lastMove) {
    const N = size * size;
    const gid = new Int16Array(N).fill(-1);
    const gColor = [];
    const gSize = [];
    const gLibs = [];
    const stack = new Int32Array(N);
    const seenLib = new Int32Array(N); // 그룹별 활로 중복 방지 (값 = 그룹 id + 1)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x;
        const v = board[y][x];
        if (v === EMPTY || gid[i] >= 0) continue;
        const g = gColor.length;
        gColor.push(v); gSize.push(0); gLibs.push(0);
        let sp = 0;
        stack[sp] = i; sp += 1; gid[i] = g;
        while (sp) {
          const c = stack[sp -= 1];
          gSize[g] += 1;
          const cx = c % size;
          const cy = (c / size) | 0;
          for (const [nx, ny] of neighbors(cx, cy, size)) {
            const j = ny * size + nx;
            const nv = board[ny][nx];
            if (nv === v && gid[j] < 0) { gid[j] = g; stack[sp] = j; sp += 1; }
            else if (nv === EMPTY && seenLib[j] !== g + 1) { seenLib[j] = g + 1; gLibs[g] += 1; }
          }
        }
      }
    }

    let stones = 0;
    for (let g = 0; g < gSize.length; g += 1) stones += gSize[g];
    const opening = stones < size * 2;
    const priors = new Float64Array(moves.length);
    const seenG = [];
    for (let m = 0; m < moves.length; m += 1) {
      const [x, y] = moves[m];
      let score = 0;
      let emptyN = 0;
      seenG.length = 0;
      for (const [nx, ny] of neighbors(x, y, size)) {
        const j = ny * size + nx;
        if (board[ny][nx] === EMPTY) { emptyN += 1; continue; }
        const g = gid[j];
        if (seenG.includes(g)) continue;
        seenG.push(g);
        if (gColor[g] !== color) {
          if (gLibs[g] === 1) score += 14 + gSize[g] * 1.5; // 잡기
          else if (gLibs[g] === 2) score += 4;              // 단수로 몰기
        } else {
          if (gLibs[g] === 1) score += 10 + gSize[g];       // 단수 그룹 살리기
          else if (gLibs[g] === 2) score += 1.5;            // 연결·보강
        }
      }
      score += emptyN * 0.8;
      if (lastMove) {
        const d = Math.max(Math.abs(x - lastMove[0]), Math.abs(y - lastMove[1]));
        if (d === 1) score += 3;
        else if (d === 2) score += 2;
        else if (d === 3) score += 1;
      }
      if (opening && size >= 13) {
        const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
        if (edge === 2 || edge === 3) score += 2.5;
        else if (edge === 0) score -= 4;
        else if (edge === 1) score -= 1.5;
      }
      priors[m] = 1 / (1 + Math.exp(-score / 8)); // 승률 스케일(0.5 중심)로 눌러 담기
    }
    return priors;
  }

  // ── 트리 ────────────────────────────────────────────────────
  function makeMctsNode(board, turn, koKey, move, parent, size, cfg) {
    return {
      board, turn, koKey, move, size, cfg,
      parent: parent || null,
      moverColor: parent ? parent.turn : null, // 이 노드로 오려고 둔 색
      children: [],
      untried: null, // 게으른 생성: 처음 다시 방문될 때 채운다(materializeMoves)
      priors: null,
      ui: 0, // 다음에 확장할 untried 인덱스(정렬돼 있으면 유망수 우선)
      visits: 0,
      wins: 0, // moverColor 기준 승수
      raveN: 0,
      raveW: 0, // moverColor 기준 AMAF 승수
    };
  }

  // 후보 생성(genMoves+priors)은 노드당 비용이 커서(19×19 후보 ~250개 배열 할당)
  // 생성 시점이 아니라 "노드가 다시 선택될 때" 채운다. 대부분의 잎은 재방문되지
  // 않으므로 반복당 비용·GC 압력이 크게 준다(같은 국면이면 결과는 동일 — 순수 지연).
  function materializeMoves(node) {
    if (node.untried !== null) return;
    const { board, turn, size, cfg } = node;
    const mask = cfg.restrict ? allowedMask(board, size) : null;
    const untried = genMoves(board, turn, size, node.koKey, mask);
    let priors = null;
    if (cfg.priors && untried.length) {
      priors = computePriors(board, untried, turn, size, node.move);
      // 유망수(높은 prior)부터 확장하도록 함께 정렬
      const order = untried.map((mv, i) => [priors[i], mv]).sort((a, b) => b[0] - a[0]);
      for (let i = 0; i < order.length; i += 1) { priors[i] = order[i][0]; untried[i] = order[i][1]; }
    }
    node.untried = untried;
    node.priors = priors;
  }

  function selectUct(node, useRave) {
    let best = null;
    let bestVal = -Infinity;
    const lnN = Math.log(node.visits);
    // β: 방문이 적을 땐 RAVE(형제 공유 통계)를, 쌓일수록 실측 승률을 믿는다
    const beta = useRave ? Math.sqrt(RAVE_K / (3 * node.visits + RAVE_K)) : 0;
    for (const c of node.children) {
      const q = c.wins / c.visits;
      let val;
      if (useRave && c.raveN > 0) {
        val = (1 - beta) * q + beta * (c.raveW / c.raveN) + RAVE_C * Math.sqrt(lnN / c.visits);
      } else {
        val = q + UCT_C * Math.sqrt(lnN / c.visits);
      }
      if (val > bestVal) { bestVal = val; best = c; }
    }
    return best;
  }

  // ── 고속 플레이아웃 ──────────────────────────────────────────
  // MCTS의 병목은 매 수 보드를 복제(applySim)하고 Set을 할당(getGroup)하는 무작위
  // 대국이다. 그래서 플레이아웃만 평탄 Int8Array + 제자리 착수 + 증분 빈점 리스트로
  // 다시 써서(트리 부분은 기존 함수 유지) 10배 이상 빠르게 만든다. 인덱스 = y*size + x.
  let PL = null; // 플레이아웃용 재사용 버퍼(단일 스레드·비재진입이라 공유 안전)

  function ensurePlayout(size) {
    if (PL && PL.size === size) return;
    const N = size * size;
    const nbrList = new Int32Array(N * 4);
    const nbrCnt = new Int8Array(N);
    const nbr8List = new Int32Array(N * 8); // 지역성 응수용 8방(대각 포함) 이웃
    const nbr8Cnt = new Int8Array(N);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x;
        const base = i * 4;
        let c = 0;
        if (y > 0) { nbrList[base + c] = i - size; c += 1; }
        if (y < size - 1) { nbrList[base + c] = i + size; c += 1; }
        if (x > 0) { nbrList[base + c] = i - 1; c += 1; }
        if (x < size - 1) { nbrList[base + c] = i + 1; c += 1; }
        nbrCnt[i] = c;
        const base8 = i * 8;
        let c8 = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            nbr8List[base8 + c8] = ny * size + nx; c8 += 1;
          }
        }
        nbr8Cnt[i] = c8;
      }
    }
    PL = {
      size, N, nbrList, nbrCnt, nbr8List, nbr8Cnt,
      b: new Int8Array(N), mark: new Int32Array(N), stack: new Int32Array(N),
      grp: new Int32Array(N), empties: new Int32Array(N), pos: new Int32Array(N),
      seen: new Int32Array(N), seenGen: 0, // 시드 채집용 방문 표시(plScan의 mark/gen과 분리)
      amafColor: new Int8Array(N), amafGen: new Int32Array(N), amafG: 0, // RAVE용: 이번 시뮬에서 그 점에 처음 둔 색
      ec: 0, gen: 1, scanCount: 0, scanLib: -1, koNext: -1,
    };
  }

  // (start) 돌이 속한 그룹의 활로 수를 세고, grp[0..scanCount)에 돌 인덱스를,
  // scanLib에 활로 한 곳을 담는다(단수 처리용).
  // libCap: 활로가 cap개에 도달하면 조기 종료(반환값 ≥ cap 의미). 큰 판 종반엔 그룹이
  // 100돌을 넘어 매 수 전체 스캔이 병목이 되는데, 판정엔 "0/1/2+"만 필요할 때가
  // 대부분이라 조기 종료가 플레이아웃을 수 배 빠르게 만든다. cap에 안 걸리고 끝나면
  // 정확한 활로 수·scanCount(그룹 돌 수)가 보장된다.
  function plScan(start, libCap) {
    const { b, mark, stack, grp, nbrList, nbrCnt } = PL;
    const cap = libCap || Infinity;
    PL.gen += 1;
    const gen = PL.gen;
    const color = b[start];
    stack[0] = start; mark[start] = gen; grp[0] = start;
    let sp = 1, count = 1, libs = 0, lib = -1;
    while (sp) {
      const c = stack[sp -= 1];
      const base = c * 4;
      const nc = nbrCnt[c];
      for (let k = 0; k < nc; k += 1) {
        const j = nbrList[base + k];
        if (mark[j] === gen) continue;
        const v = b[j];
        if (v === color) { mark[j] = gen; stack[sp] = j; sp += 1; grp[count] = j; count += 1; }
        else if (v === EMPTY) {
          mark[j] = gen; libs += 1; lib = j;
          if (libs >= cap) { PL.scanCount = count; PL.scanLib = lib; return libs; }
        }
      }
    }
    PL.scanCount = count; PL.scanLib = lib;
    return libs;
  }

  function plRemoveEmpty(i) { const p = PL.pos[i]; PL.ec -= 1; const last = PL.empties[PL.ec]; PL.empties[p] = last; PL.pos[last] = p; }
  function plAddEmpty(i) { PL.pos[i] = PL.ec; PL.empties[PL.ec] = i; PL.ec += 1; }

  function plIsEye(i, color) {
    const base = i * 4, cnt = PL.nbrCnt[i];
    for (let k = 0; k < cnt; k += 1) if (PL.b[PL.nbrList[base + k]] !== color) return false;
    return true;
  }

  // 제자리 착수: 잡힌 상대 그룹을 들어낸다. 자살수면 되돌리고 -1, 아니면 잡은 수 반환.
  function plPlace(i, color) {
    const b = PL.b;
    const opp = color === BLACK ? WHITE : BLACK;
    const base = i * 4, cnt = PL.nbrCnt[i];
    b[i] = color;
    let captured = 0, capIdx = -1;
    for (let k = 0; k < cnt; k += 1) {
      const j = PL.nbrList[base + k];
      if (b[j] !== opp) continue;
      if (plScan(j, 1) === 0) {
        for (let m = 0; m < PL.scanCount; m += 1) { const s = PL.grp[m]; b[s] = EMPTY; plAddEmpty(s); capIdx = s; }
        captured += PL.scanCount;
      }
    }
    const myLibs = plScan(i, 2); // 0=자살수, 1=정확(패 판정용), 2=조기 종료(2 이상)
    if (myLibs === 0) { b[i] = EMPTY; return -1; } // 자살수(따낸 게 있으면 활로가 생겨 여기 안 옴)
    plRemoveEmpty(i);
    PL.koNext = (captured === 1 && PL.scanCount === 1 && myLibs === 1) ? capIdx : -1;
    return captured;
  }

  function plAreaWinner(size) {
    const b = PL.b, N = PL.N, stack = PL.stack, mark = PL.mark, nbrList = PL.nbrList, nbrCnt = PL.nbrCnt;
    let black = 0, white = komiFor(size);
    for (let i = 0; i < N; i += 1) { const v = b[i]; if (v === BLACK) black += 1; else if (v === WHITE) white += 1; }
    PL.gen += 1;
    const vg = PL.gen;
    for (let i = 0; i < N; i += 1) {
      if (b[i] !== EMPTY || mark[i] === vg) continue;
      let sp = 0, cnt = 0, tb = false, tw = false;
      stack[sp] = i; sp += 1; mark[i] = vg;
      while (sp) {
        const c = stack[sp -= 1]; cnt += 1;
        const base = c * 4, nc = nbrCnt[c];
        for (let k = 0; k < nc; k += 1) {
          const j = nbrList[base + k]; const v = b[j];
          if (v === EMPTY) { if (mark[j] !== vg) { mark[j] = vg; stack[sp] = j; sp += 1; } }
          else if (v === BLACK) tb = true; else tw = true;
        }
      }
      if (tb && !tw) black += cnt; else if (tw && !tb) white += cnt;
    }
    return black > white ? BLACK : WHITE;
  }

  // 무작위 대국을 끝까지 둔 뒤 중국식 면적으로 승자를 돌려준다.
  // startKo(트리의 문자열 패 키)는 플레이아웃 첫 수에만 영향 → 무시한다(랜덤 대국이라 무해).
  function mctsPlayout(startBoard, startTurn, startKo, size, startLast) {
    ensurePlayout(size);
    // 세대 카운터 리셋: PL.gen이 Int32Array(mark) 범위(2^31)를 넘으면 저장값이 음수로
    // 랩돼 "mark[i] === gen"이 영원히 거짓 → flood-fill이 무한 재방문(행). plScan이
    // 호출당 1씩 올려 19×19 실전 예산 기준 수십 수마다 도달하는 실 버그다. 한 플레이
    // 아웃의 증가량(<10만)에 큰 여유를 둔 문턱에서 배열과 함께 리셋한다.
    if (PL.gen > 2000000000) { PL.gen = 1; PL.mark.fill(0); }
    if (PL.seenGen > 2000000000) { PL.seenGen = 1; PL.seen.fill(0); }
    if (PL.amafG > 2000000000) { PL.amafG = 1; PL.amafGen.fill(0); }
    const b = PL.b, N = PL.N;
    PL.amafG += 1; // 이번 시뮬레이션의 AMAF 기록 세대
    PL.ec = 0;
    for (let y = 0; y < size; y += 1) { const row = startBoard[y]; for (let x = 0; x < size; x += 1) b[y * size + x] = row[x]; }
    for (let i = 0; i < N; i += 1) if (b[i] === EMPTY) { PL.pos[i] = PL.ec; PL.empties[PL.ec] = i; PL.ec += 1; }
    let turn = startTurn;
    let ko = -1;
    let last = startLast ? startLast[1] * size + startLast[0] : -1;
    let passes = 0;
    // 시작 국면에서 이미 단수인 그룹의 활로(뜨거운 점)를 채집한다. 아래 긴급수 처리는
    // "직전 수 주변"만 보므로, 뿌리 국면에서 물려받은 단수는 여기서 시딩하지 않으면
    // 무작위 대국이 잡히기 직전 그룹을 못 본 채 지나쳐 사활 평가가 왜곡된다(미끼 방치 등).
    PL.seenGen += 1;
    const sg = PL.seenGen;
    const seeds = [];
    for (let i = 0; i < N; i += 1) {
      if (b[i] === EMPTY || PL.seen[i] === sg) continue;
      const libs = plScan(i, 2); // 조기 종료 시 그룹 일부만 표시되지만 재스캔도 곧 종료돼 저렴
      for (let m = 0; m < PL.scanCount; m += 1) PL.seen[PL.grp[m]] = sg;
      if (libs === 1) seeds.push(PL.scanLib);
    }
    const cap = N * 2 + 10;
    for (let step = 0; step < cap && passes < 2; step += 1) {
      const opp = turn === BLACK ? WHITE : BLACK;
      let played = false;
      // 0) 물려받은 단수 처리: 시드 점이 아직 뜨거우면(옆에 단수 그룹) 우선 둔다.
      //    내 그룹이면 잇기, 상대 그룹이면 따냄 — 어느 쪽이든 그 점이 급소다.
      if (seeds.length && Math.random() < 0.9) {
        while (!played && seeds.length) {
          const u = seeds[seeds.length - 1];
          if (b[u] !== EMPTY || u === ko || plIsEye(u, turn)) { seeds.pop(); continue; }
          let hot = false;
          const base = u * 4, cnt = PL.nbrCnt[u];
          for (let k = 0; k < cnt; k += 1) {
            const j = PL.nbrList[base + k];
            if (b[j] !== EMPTY && plScan(j, 2) === 1) { hot = true; break; }
          }
          if (!hot) { seeds.pop(); continue; }
          if (plPlace(u, turn) >= 0) { ko = PL.koNext; last = u; played = true; }
          seeds.pop();
        }
      }
      // 1) 긴급수: 직전 상대 수 주변의 단수만 값싸게 처리(잡기 → 살리기).
      if (!played && last >= 0 && Math.random() < 0.9) {
        let u1 = -1, u2 = -1;
        if (plScan(last, 2) === 1) u1 = PL.scanLib; // 방금 둔 상대 그룹이 단수 → 잡는다
        const base = last * 4, cnt = PL.nbrCnt[last];
        for (let k = 0; k < cnt; k += 1) {
          const j = PL.nbrList[base + k];
          if (b[j] !== turn) continue;
          if (plScan(j, 2) === 1) { u2 = PL.scanLib; break; } // 단수로 몰린 내 그룹 → 잇는다
        }
        for (let t = 0; t < 2; t += 1) {
          const u = t === 0 ? u1 : u2;
          if (u < 0 || u === ko || plIsEye(u, turn)) continue;
          if (plPlace(u, turn) >= 0) { ko = PL.koNext; last = u; played = true; break; }
        }
      }
      // 1.5) 지역성: 절반의 확률로 직전 수의 8방 이웃에 응수한다. 무작위 대국이
      //      판 전체에 흩어지는 대신 실제 바둑처럼 접전이 이어져, 같은 시뮬 수로
      //      사활·전투 평가가 훨씬 정확해진다(큰 판일수록 효과 큼).
      if (!played && last >= 0 && Math.random() < 0.5) {
        const base8 = last * 8, cnt8 = PL.nbr8Cnt[last];
        const off = (Math.random() * cnt8) | 0;
        for (let t = 0; t < 3; t += 1) { // 8방 중 무작위 3곳만 시도(과도한 밀착 방지)
          const j = PL.nbr8List[base8 + ((off + t) % cnt8)];
          if (b[j] !== EMPTY || j === ko || plIsEye(j, turn)) continue;
          if (plPlace(j, turn) >= 0) { ko = PL.koNext; last = j; played = true; break; }
        }
      }
      // 2) 무작위(거부 샘플링)
      if (!played) {
        let att = 0; const maxAtt = PL.ec * 2 + 4;
        PL.gen += 1; const tg = PL.gen;
        while (att < maxAtt && PL.ec > 0) {
          att += 1;
          const idx = PL.empties[(Math.random() * PL.ec) | 0];
          if (PL.mark[idx] === tg) continue;
          PL.mark[idx] = tg;
          if (idx === ko || plIsEye(idx, turn)) continue;
          if (plPlace(idx, turn) >= 0) { ko = PL.koNext; last = idx; played = true; break; }
        }
      }
      // 3) 폴백: 남은 합법 비-눈 수 선형 탐색(무작위가 놓쳤을 때만)
      if (!played) {
        for (let k = 0; k < PL.ec; k += 1) {
          const idx = PL.empties[k];
          if (idx === ko || plIsEye(idx, turn)) continue;
          if (plPlace(idx, turn) >= 0) { ko = PL.koNext; last = idx; played = true; break; }
        }
      }
      if (!played) { passes += 1; turn = opp; ko = -1; last = -1; continue; }
      // RAVE용 AMAF 기록: 이 점에 이번 시뮬레이션에서 처음 둔 색만 남긴다
      if (PL.amafGen[last] !== PL.amafG) { PL.amafGen[last] = PL.amafG; PL.amafColor[last] = turn; }
      passes = 0; turn = opp;
    }
    return plAreaWinner(size);
  }

  // ── 탐색 본체 ───────────────────────────────────────────────
  // 시간(budgetMs) 또는 반복 횟수(maxIters, 검증용) 예산 안에서 UCT 탐색.
  function mctsSearch(pos, opts = {}) {
    const size = pos.size;
    const cfg = {
      priors: opts.priors !== false,
      restrict: opts.restrict !== false,
      rave: opts.rave !== false,
    };
    const root = makeMctsNode(pos.board, pos.turn, pos.koKey || null, pos.lastMove || null, null, size, cfg);
    materializeMoves(root);
    if (!root.untried.length) return null; // 둘 곳(자기 눈 제외)이 없으면 패스
    // 루트 후보에서 "축으로 죽는" 수를 제거(대안이 있을 때만).
    // 비용 상한 필수: 중반 접전에선 2활로 후보가 수십 개라 "후보 × 축읽기(최대 500노드
    // × 보드복제)"가 수십 초로 폭발하고, 그 할당 폭풍이 V8 재최적화 루프까지 일으켜
    // 한 수가 수십 분씩 걸렸다(19×19 ~100수 행 버그). prior 상위 40개·총 150ms까지만
    // 검사하고 나머지는 통과시킨다 — 축 도주는 prior가 높아 상위에 몰리므로 손실 미미.
    if (root.untried.length > 1) {
      const kept = [];
      const keptPr = [];
      const lt0 = Date.now();
      for (let i = 0; i < root.untried.length; i += 1) {
        const mv = root.untried[i];
        if (i < 40 && Date.now() - lt0 < 150) {
          const sim = applySim(root.board, mv[0], mv[1], root.turn);
          if (sim && ladderDoomed(sim.board, mv[0], mv[1])) continue;
        }
        kept.push(mv);
        if (root.priors) keptPr.push(root.priors[i]);
      }
      if (kept.length && kept.length < root.untried.length) {
        root.untried = kept;
        if (root.priors) root.priors = Float64Array.from(keptPr);
      }
    }
    const iterCap = opts.maxIters || MCTS_MAX_ITERS;
    const useClock = !opts.maxIters;
    const deadline = Date.now() + (opts.budgetMs || 600);
    let iters = 0;
    while (iters < iterCap && (!useClock || Date.now() < deadline)) {
      iters += 1;
      let node = root;
      while (true) {
        if (node.untried === null) materializeMoves(node);
        if (node.ui < node.untried.length || !node.children.length) break;
        node = selectUct(node, cfg.rave);
      }
      if (node.ui < node.untried.length) {
        // prior 정렬 순(없으면 생성 순)으로 확장. prior는 가상 방문으로 심는다.
        const idx = node.priors ? node.ui : node.ui + Math.floor(Math.random() * (node.untried.length - node.ui));
        const mv = node.untried[idx];
        node.untried[idx] = node.untried[node.ui];
        node.untried[node.ui] = mv;
        const h = node.priors ? node.priors[idx] : 0;
        if (node.priors) { node.priors[idx] = node.priors[node.ui]; node.priors[node.ui] = h; }
        node.ui += 1;
        const sim = applySim(node.board, mv[0], mv[1], node.turn);
        const childKo = koKeyAfter(node.board, sim.board, sim.captured, mv[0], mv[1]);
        const child = makeMctsNode(sim.board, otherColor(node.turn), childKo, mv, node, size, cfg);
        if (node.priors) {
          child.visits = PRIOR_N; child.wins = PRIOR_N * h;
          child.raveN = PRIOR_N; child.raveW = PRIOR_N * h;
        }
        node.children.push(child);
        node = child;
      }
      const winner = mctsPlayout(node.board, node.turn, node.koKey, size, node.move);
      if (cfg.rave) {
        // 트리 경로에서 둔 수도 시뮬레이션의 일부 — 먼저 둔 수가 우선이므로 덮어쓴다
        for (let n = node; n.parent; n = n.parent) {
          const i = n.move[1] * size + n.move[0];
          PL.amafGen[i] = PL.amafG;
          PL.amafColor[i] = n.moverColor;
        }
      }
      for (let n = node; n; n = n.parent) {
        n.visits += 1;
        if (n.moverColor === winner) n.wins += 1;
        if (cfg.rave) {
          // RAVE: 이 노드 차례(n.turn)의 색이 시뮬 어딘가에서 둔 자리와 같은 수를 가진
          // 형제들에 AMAF 통계를 나눠 준다("그 자리에 둔 대국은 이겼나").
          const won = winner === n.turn ? 1 : 0;
          for (const c of n.children) {
            const i = c.move[1] * size + c.move[0];
            if (PL.amafGen[i] === PL.amafG && PL.amafColor[i] === n.turn) {
              c.raveN += 1;
              c.raveW += won;
            }
          }
        }
      }
    }
    let best = null;
    let bestVisits = -1;
    for (const c of root.children) {
      if (c.visits > bestVisits) { bestVisits = c.visits; best = c; }
    }
    return best ? best.move : null;
  }

  // ── 급수(1~18급) → 엔진 매핑 (19×19 전용, 앱·워커 공용 단일 출처) ──
  // 18~16급: 메인 스레드 점수표 봇 / 15~8급: GNU Go 레벨 / 7~1급: KataGo 정책망(온도 약화).
  // GNU Go 레벨 10 ≈ 8~10급(공인 실측 앵커), KataGo 정책망 최강 ≈ 단급 초입.
  // 7~1급 파라미터는 자체대국 캘리브레이션 실측(2026-07, 인접 대진 20판·색 교대):
  // 인접 승률 60~75%(정상 간격), 7급 vs 8급 앵커 65%. 바꿀 땐 재캘리브레이션 필수
  // — 이 구간은 온도에 민감해 반 단계(t1.6→1.8)로도 두 급수가 뒤집힌다.
  const RANK_SPECS = {
    18: { engine: "bot", mode: "easy" },
    17: { engine: "bot", mode: "medium" },
    16: { engine: "bot", mode: "deep" }, // 점수표 + 3수 읽기
    15: { engine: "gnugo", level: 1 },
    14: { engine: "gnugo", level: 2 },
    13: { engine: "gnugo", level: 3 },
    12: { engine: "gnugo", level: 4 },
    11: { engine: "gnugo", level: 5 },
    10: { engine: "gnugo", level: 6 },
    9: { engine: "gnugo", level: 8 },
    8: { engine: "gnugo", level: 10 },
    7: { engine: "kata", topK: 14, temp: 1.6 },
    6: { engine: "kata", topK: 12, temp: 1.5 },
    5: { engine: "kata", topK: 10, temp: 1.2 },
    4: { engine: "kata", topK: 8, temp: 1.0 },
    3: { engine: "kata", topK: 6, temp: 0.8 },
    2: { engine: "kata", topK: 4, temp: 0.65 },
    1: { engine: "kata", topK: 1, temp: 0 },
  };
  function rankSpec(rank) { return RANK_SPECS[rank] || null; }

  globalThis.BadukAI = { mctsSearch, rankSpec };
})();
