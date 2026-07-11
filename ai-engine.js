// ai-engine.js — 고급 AI(MCTS) 순수 엔진. DOM/앱 상태에 묶이지 않는다.
// 세 환경에서 같은 파일을 쓴다:
//  - 브라우저 메인 스레드: <script src="ai-engine.js"> (워커 실패 시 동기 폴백)
//  - Web Worker: importScripts("ai-engine.js") — 평소 계산은 여기서 돈다
//  - Node: require("./ai-engine.js") — tools/ai-check.js 자체대국 검증
// 진입점: globalThis.BadukAI.mctsSearch(pos, opts)
//   pos  = { board(2차원 배열), turn, koKey, size }
//   opts = { budgetMs(시간 예산), maxIters(반복 예산 — 검증용, 있으면 시계 무시),
//            priors(휴리스틱 사전지식 주입, 기본 on), restrict(큰 판 후보 제한, 기본 on) }
// 알고리즘: UCT 몬테카를로 트리 탐색.
//  - 판을 끝까지 둬 보고 실제 집을 세므로 점수표와 달리 집·사활·판세를 스스로 읽는다.
//  - 큰 판(13·19) 대응 2단계 강화: ① 후보를 "돌 근처 2칸 + 화점"으로 좁혀 분기 축소
//    ② 잡기/살리기/근접 같은 값싼 휴리스틱을 가상 방문(prior)으로 심어 유망수부터 탐색.
(() => {
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const komiFor = (size) => (size === 5 ? 0.5 : 6.5);
  const MCTS_MAX_ITERS = 40000;
  const UCT_C = 1.4;
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
  function ladderCaptured(board, gx, gy, depth) {
    if (depth > 40) return false;
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
    const mask = cfg.restrict ? allowedMask(board, size) : null;
    const untried = genMoves(board, turn, size, koKey, mask);
    let priors = null;
    if (cfg.priors && untried.length) {
      priors = computePriors(board, untried, turn, size, move);
      // 유망수(높은 prior)부터 확장하도록 함께 정렬
      const order = untried.map((mv, i) => [priors[i], mv]).sort((a, b) => b[0] - a[0]);
      for (let i = 0; i < order.length; i += 1) { priors[i] = order[i][0]; untried[i] = order[i][1]; }
    }
    return {
      board, turn, koKey, move,
      parent: parent || null,
      moverColor: parent ? parent.turn : null, // 이 노드로 오려고 둔 색
      children: [],
      untried,
      priors,
      ui: 0, // 다음에 확장할 untried 인덱스(정렬돼 있으면 유망수 우선)
      visits: 0,
      wins: 0, // moverColor 기준 승수
    };
  }

  function selectUct(node) {
    let best = null;
    let bestVal = -Infinity;
    const lnN = Math.log(node.visits);
    for (const c of node.children) {
      const val = c.wins / c.visits + UCT_C * Math.sqrt(lnN / c.visits);
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
      }
    }
    PL = {
      size, N, nbrList, nbrCnt,
      b: new Int8Array(N), mark: new Int32Array(N), stack: new Int32Array(N),
      grp: new Int32Array(N), empties: new Int32Array(N), pos: new Int32Array(N),
      seen: new Int32Array(N), seenGen: 0, // 시드 채집용 방문 표시(plScan의 mark/gen과 분리)
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
    const b = PL.b, N = PL.N;
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
    };
    const root = makeMctsNode(pos.board, pos.turn, pos.koKey || null, pos.lastMove || null, null, size, cfg);
    if (!root.untried.length) return null; // 둘 곳(자기 눈 제외)이 없으면 패스
    // 루트 후보에서 "축으로 죽는" 수를 제거(대안이 있을 때만). 루트 한정이라 비용 미미.
    if (root.untried.length > 1) {
      const kept = [];
      const keptPr = [];
      for (let i = 0; i < root.untried.length; i += 1) {
        const mv = root.untried[i];
        const sim = applySim(root.board, mv[0], mv[1], root.turn);
        if (sim && ladderDoomed(sim.board, mv[0], mv[1])) continue;
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
      while (node.ui >= node.untried.length && node.children.length) node = selectUct(node);
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
        if (node.priors) { child.visits = PRIOR_N; child.wins = PRIOR_N * h; }
        node.children.push(child);
        node = child;
      }
      const winner = mctsPlayout(node.board, node.turn, node.koKey, size, node.move);
      for (let n = node; n; n = n.parent) {
        n.visits += 1;
        if (n.moverColor === winner) n.wins += 1;
      }
    }
    let best = null;
    let bestVisits = -1;
    for (const c of root.children) {
      if (c.visits > bestVisits) { bestVisits = c.visits; best = c; }
    }
    return best ? best.move : null;
  }

  globalThis.BadukAI = { mctsSearch };
})();
