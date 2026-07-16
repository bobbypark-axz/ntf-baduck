// kata-engine.js — KataGo b10c128 정책망(TF.js) 착수 생성기. 워커 전용.
// 19×19 상위 급수(7급~1급)가 쓴다. 탐색 없이 신경망 순전파 1회로 착수를 고른다
// (정책망 단독 ≈ 인터넷 바둑 단급 초입 — GNU Go 상한(~8급) 위를 이걸로 채운다).
//
// 입력 인코딩: KataGo cpp/neuralnet/nninputs.cpp fillRowV7 사양(model version 8).
// 앱 워커 프로토콜이 무상태(매 요청 전체 국면)라 KataGo의 hideHistory 모드로 맞춘다
// — 최근 수 평면(ch9~13)과 패스 플래그를 비우는 인코딩은 학습 분포 안에 있어
// (종국 인접 국면 등에서 실제로 쓰임) 실력 저하가 미미하다.
// 룰 고정: territory scoring + tax none + simple ko → 글로벌 피처 대부분 0 (앱 룰과 일치).
//
// 급수 조절: 정책 로짓 상위 topK에서 온도(temp) 샘플링. topK=1이면 최강(argmax).
(() => {
  const EMPTY = 0, BLACK = 1, WHITE = 2;
  const N = 19, AREA = N * N, PASS_IDX = AREA;

  const other = (c) => (c === BLACK ? WHITE : BLACK);

  function neighbors(x, y) {
    const out = [];
    if (x > 0) out.push([x - 1, y]);
    if (x < N - 1) out.push([x + 1, y]);
    if (y > 0) out.push([x, y - 1]);
    if (y < N - 1) out.push([x, y + 1]);
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
      const key = cx + "," + cy;
      if (visited.has(key)) continue;
      visited.add(key);
      stones.push([cx, cy]);
      for (const [nx, ny] of neighbors(cx, cy)) {
        const v = board[ny][nx];
        if (v === EMPTY) liberties.add(nx + "," + ny);
        else if (v === color && !visited.has(nx + "," + ny)) stack.push([nx, ny]);
      }
    }
    return { stones, liberties };
  }

  // 가상 착수(따냄 반영). 자살수면 null.
  function play(board, x, y, color) {
    if (board[y][x] !== EMPTY) return null;
    const next = board.map((r) => r.slice());
    next[y][x] = color;
    const opp = other(color);
    let captured = 0;
    for (const [nx, ny] of neighbors(x, y)) {
      if (next[ny][nx] !== opp) continue;
      const g = getGroup(next, nx, ny);
      if (g.liberties.size === 0) {
        captured += g.stones.length;
        for (const [sx, sy] of g.stones) next[sy][sx] = EMPTY;
      }
    }
    if (getGroup(next, x, y).liberties.size === 0) return null;
    return { board: next, captured };
  }

  // ── 사다리(축) 읽기: ch14/17 근사 (ai-engine.js의 축 읽기와 같은 계열) ──
  function ladderCaptured(board, gx, gy, depth, budget) {
    budget.nodes += 1;
    if (depth > 40 || budget.nodes > 600) return false;
    const color = board[gy][gx];
    const opp = other(color);
    const group = getGroup(board, gx, gy);
    if (group.liberties.size === 0) return true;
    if (group.liberties.size >= 2) return false;
    const [lx, ly] = [...group.liberties][0].split(",").map(Number);
    const run = play(board, lx, ly, color);
    if (!run) return true;
    const after = getGroup(run.board, lx, ly);
    if (after.liberties.size >= 3 || (run.captured > 0 && after.liberties.size >= 2)) return false;
    if (after.liberties.size <= 1) return true;
    for (const key of after.liberties) {
      const [ax, ay] = key.split(",").map(Number);
      const chase = play(run.board, ax, ay, opp);
      if (!chase) continue;
      if (getGroup(chase.board, ax, ay).liberties.size <= 1) continue;
      if (getGroup(chase.board, lx, ly).liberties.size === 1 && ladderCaptured(chase.board, lx, ly, depth + 1, budget)) return true;
    }
    return false;
  }

  function ladderStatus(board, x, y) {
    const group = getGroup(board, x, y);
    const libs = group.liberties.size;
    const opp = other(board[y][x]);
    if (libs === 1) return { laddered: ladderCaptured(board, x, y, 0, { nodes: 0 }), working: [] };
    if (libs === 2) {
      const working = [];
      for (const key of group.liberties) {
        const [ax, ay] = key.split(",").map(Number);
        const chase = play(board, ax, ay, opp);
        if (!chase) continue;
        if (getGroup(chase.board, ax, ay).liberties.size <= 1) continue;
        const g2 = getGroup(chase.board, x, y);
        if (g2.liberties.size === 1 && ladderCaptured(chase.board, x, y, 0, { nodes: 0 })) working.push([ax, ay]);
      }
      return { laddered: working.length > 0, working };
    }
    return { laddered: false, working: [] };
  }

  // V7 인코딩 (hideHistory): bin [361,22] NHWC + global [19]
  function encode(board, toMove, koPoint) {
    const opp = other(toMove);
    const bin = new Float32Array(AREA * 22);
    const glob = new Float32Array(19);

    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        const base = (y * N + x) * 22;
        bin[base + 0] = 1;
        const stone = board[y][x];
        if (stone === toMove) bin[base + 1] = 1;
        else if (stone === opp) bin[base + 2] = 1;
        if (stone) {
          const libs = getGroup(board, x, y).liberties.size;
          if (libs === 1) bin[base + 3] = 1;
          else if (libs === 2) bin[base + 4] = 1;
          else if (libs === 3) bin[base + 5] = 1;
        }
      }
    }
    if (koPoint) bin[(koPoint[1] * N + koPoint[0]) * 22 + 6] = 1;

    // 사다리: ch14 현재 보드, ch15/16은 hideHistory 규약상 같은 보드, ch17 잡는 수
    const seen = new Set();
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        if (!board[y][x]) continue;
        const group = getGroup(board, x, y);
        const hk = group.stones[0][0] + "," + group.stones[0][1];
        if (seen.has(hk)) continue;
        seen.add(hk);
        const libs = group.liberties.size;
        if (libs !== 1 && libs !== 2) continue;
        const st = ladderStatus(board, x, y);
        if (!st.laddered) continue;
        for (const [sx, sy] of group.stones) {
          const b = (sy * N + sx) * 22;
          bin[b + 14] = 1; bin[b + 15] = 1; bin[b + 16] = 1;
        }
        if (board[y][x] === opp && libs === 2) {
          for (const [wx, wy] of st.working) bin[(wy * N + wx) * 22 + 17] = 1;
        }
      }
    }

    glob[5] = (toMove === WHITE ? 6.5 : -6.5) / 20; // selfKomi/20
    glob[9] = 1; // territory scoring (앱 계가 방식과 일치)
    return { bin, glob };
  }

  let model = null;

  async function init(opts) {
    if (model) return;
    if (opts && opts.wasmDir && tf.wasm) tf.wasm.setWasmPaths(opts.wasmDir);
    for (const b of ["webgl", "wasm", "cpu"]) {
      try { if (await tf.setBackend(b)) break; } catch (e) { /* 다음 백엔드 */ }
    }
    await tf.ready();
    model = await tf.loadGraphModel(opts.modelUrl);
    // 워밍업(셰이더/커널 컴파일을 첫 착수 전에 끝낸다)
    await genmove(Array.from({ length: N }, () => new Array(N).fill(EMPTY)), BLACK, null, {});
  }

  // 착수 생성. temp>0 && topK>1이면 상위 topK 로짓 온도 샘플링(급수 약화).
  // 반환: [x,y] 또는 null(패스가 최선일 때).
  async function genmove(board, toMove, koPoint, { temp = 0, topK = 1 } = {}) {
    const { bin, glob } = encode(board, toMove, koPoint);
    const binT = tf.tensor(bin, [1, AREA, 22]);
    const globT = tf.tensor(glob, [1, 19]);
    const out = await model.executeAsync(
      { "swa_model/bin_inputs": binT, "swa_model/global_inputs": globT },
      ["swa_model/policy_output"],
    );
    const polT = Array.isArray(out) ? out[0] : out;
    const shape = polT.shape; // [1,362,2](공식 변환) 또는 [1,2,362]
    const data = await polT.data();
    binT.dispose(); globT.dispose(); polT.dispose();
    const logit = shape[1] === 2
      ? (i) => data[i]
      : (i) => data[i * 2];

    const cand = [];
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        if (board[y][x] !== EMPTY) continue;
        if (koPoint && koPoint[0] === x && koPoint[1] === y) continue;
        if (!play(board, x, y, toMove)) continue; // 자살수 제외
        cand.push({ x, y, logit: logit(y * N + x) });
      }
    }
    cand.push({ pass: true, logit: logit(PASS_IDX) });
    cand.sort((a, b) => b.logit - a.logit);

    let pick = cand[0];
    if (temp > 0 && topK > 1 && cand.length > 1) {
      const pool = cand.slice(0, Math.min(topK, cand.length));
      const mx = pool[0].logit;
      const ws = pool.map((c) => Math.exp((c.logit - mx) / temp));
      let r = Math.random() * ws.reduce((a, b) => a + b, 0);
      for (let i = 0; i < pool.length; i += 1) { r -= ws[i]; if (r <= 0) { pick = pool[i]; break; } }
    }
    return pick.pass ? null : [pick.x, pick.y];
  }

  globalThis.KataEngine = { init, genmove };
})();
