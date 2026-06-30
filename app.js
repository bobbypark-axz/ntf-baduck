(() => {
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  // 코미(덤): 5×5 입문은 25점짜리 작은 판이라 6.5는 과해 0.5만, 그 외는 표준 6.5.
  const komiFor = (size) => (size === 5 ? 0.5 : 6.5);
  const COLS = "ABCDEFGHJKLMNOPQRST".split("");
  const HINT_LIMIT = 3;
  const TIPS_OPENING = [
    "포석은 모서리부터, 그 다음 변, 그 다음 중앙.",
    "처음에는 화점·소목 같은 별점 근처가 좋아요.",
    "한쪽 모서리에 너무 오래 머무르지 마세요.",
  ];
  const TIPS_MIDGAME = [
    "두 점 머리는 두들겨라.",
    "공격하면서 집을 지어라.",
    "약한 돌을 도망가게 두지 말고 공격하라.",
    "내 돌이 위태로우면 한 발 물러서라.",
  ];
  const TIPS_ENDGAME = [
    "끝내기는 큰 곳부터 작은 곳으로.",
    "선수 끝내기를 먼저 챙기세요.",
    "확정된 영역은 그만 두고 다른 곳으로.",
  ];
  const DIFFICULTY_COPY = {
    easy:   { title: "초급", sub: "친근하게 한 판",   icon: "icons/sprout.svg",  tone: "green" },
    medium: { title: "중급", sub: "보통 실력",        icon: "icons/target.svg",  tone: "blue" },
    hard:   { title: "고급", sub: "더 오래 생각해요", icon: "icons/swords.svg",  tone: "red" },
  };
  const SIZE_COPY = {
    5:  { title: "초고속 한 판", sub: "5 x 5 · 1분",  time: 2 * 60 },
    9:  { title: "빠른 한 판",   sub: "9 x 9 · 5분",  time: 5 * 60 },
    19: { title: "정식판",       sub: "19 x 19 · 20분", time: 20 * 60 },
  };
  function timeBudget(size) {
    return SIZE_COPY[size] ? SIZE_COPY[size].time : 20 * 60;
  }

  function lucide(path, extraClass = "") {
    return `<img class="lucide-i ${extraClass}" src="${path}" alt="" aria-hidden="true">`;
  }

  const state = {
    size: 5,
    board: [],
    turn: BLACK,
    human: BLACK,
    ai: WHITE,
    difficulty: "easy",
    theme: "wood",
    showCoords: true,
    showLast: true,
    playerName: "나",
    moveNumber: 0,
    captures: { 1: 0, 2: 0 },
    history: [],
    lastMove: null,
    lastCaptured: [],
    lastCapturedAt: 0,
    lastEvent: "",
    lastWasPass: false,
    passes: 0,
    koKey: null,
    ended: false,
    resigned: null,
    result: null,
    resultDismissed: false,
    thinking: false,
    error: "",
    blackTime: 15 * 60,
    whiteTime: 15 * 60,
    timer: null,
    started: false,
    mobileStarted: false,
    sheetOpen: false,
    confirm: null,
    hint: null,
    hintsUsed: 0,
    timeoutLoser: null,
    phase: "play",
    deadStones: new Set(),
    endProposalCooldown: 0,
    endingNotice: "",
    aiProposing: false,
    tutorialOpen: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const app = $("#app");
  let audioContext = null;

  function playStoneSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      audioContext ||= new AudioCtx();
      if (audioContext.state === "suspended") audioContext.resume();

      const now = audioContext.currentTime;
      const gain = audioContext.createGain();
      const low = audioContext.createOscillator();
      const click = audioContext.createOscillator();
      const filter = audioContext.createBiquadFilter();

      low.type = "sine";
      low.frequency.setValueAtTime(165, now);
      low.frequency.exponentialRampToValueAtTime(92, now + 0.055);
      click.type = "triangle";
      click.frequency.setValueAtTime(720, now);
      click.frequency.exponentialRampToValueAtTime(260, now + 0.035);
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(900, now);
      filter.Q.setValueAtTime(0.8, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.105);

      low.connect(filter);
      click.connect(filter);
      filter.connect(gain);
      gain.connect(audioContext.destination);
      low.start(now);
      click.start(now);
      low.stop(now + 0.12);
      click.stop(now + 0.07);
    } catch (error) {
      // Sound is a polish feature; keep gameplay uninterrupted if audio is blocked.
    }
  }

  function emptyBoard(size) {
    return Array.from({ length: size }, () => Array(size).fill(EMPTY));
  }

  function cloneBoard(board) {
    return board.map((row) => row.slice());
  }

  function inBounds(x, y, size = state.size) {
    return x >= 0 && y >= 0 && x < size && y < size;
  }

  function neighbors(x, y, size = state.size) {
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

  function snapshot() {
    state.history.push({
      board: state.board,
      turn: state.turn,
      moveNumber: state.moveNumber,
      captures: { ...state.captures },
      lastMove: state.lastMove,
      lastWasPass: state.lastWasPass,
      passes: state.passes,
      koKey: state.koKey,
      ended: state.ended,
      resigned: state.resigned,
      result: state.result,
      resultDismissed: state.resultDismissed,
    });
  }

  function place(x, y) {
    if (state.ended) return { ok: false, reason: "ended" };
    if (!inBounds(x, y)) return { ok: false, reason: "out" };
    if (state.board[y][x] !== EMPTY) return { ok: false, reason: "occupied" };

    const color = state.turn;
    const opp = color === BLACK ? WHITE : BLACK;
    const next = cloneBoard(state.board);
    next[y][x] = color;
    const captured = [];

    for (const [nx, ny] of neighbors(x, y)) {
      if (next[ny][nx] !== opp) continue;
      const group = getGroup(next, nx, ny);
      if (group.liberties.size === 0) {
        for (const [sx, sy] of group.stones) {
          next[sy][sx] = EMPTY;
          captured.push([sx, sy]);
        }
      }
    }

    const own = getGroup(next, x, y);
    if (own.liberties.size === 0) return { ok: false, reason: "suicide" };
    const key = boardKey(next);
    if (state.koKey && key === state.koKey) return { ok: false, reason: "ko" };

    snapshot();
    state.board = next;
    state.turn = opp;
    state.moveNumber += 1;
    state.captures[color] += captured.length;
    state.lastMove = [x, y, color];
    state.lastCaptured = captured;
    state.lastCapturedAt = captured.length ? Date.now() : state.lastCapturedAt;
    state.lastEvent = captured.length ? `capture:${color}:${captured.length}` : "place";
    state.lastWasPass = false;
    state.passes = 0;
    state.hint = null;
    state.endingNotice = "";
    state.koKey = captured.length === 1 && own.stones.length === 1 && own.liberties.size === 1
      ? boardKey(state.history[state.history.length - 1].board)
      : null;
    playStoneSound();
    return { ok: true, captured: captured.length };
  }

  function pass() {
    if (state.ended || state.phase !== "play") return;
    snapshot();
    state.turn = state.turn === BLACK ? WHITE : BLACK;
    state.moveNumber += 1;
    state.lastMove = null;
    state.lastWasPass = true;
    state.passes += 1;
    state.koKey = null;
    if (state.passes >= 2) autoFinish("양측이 패스해 종국했어요.");
  }

  function resign() {
    if (state.ended || state.phase !== "play") return;
    state.ended = true;
    state.resigned = state.turn;
    state.result = scoreBoard();
    state.resultDismissed = false;
    render();
  }

  // 승부가 압도적으로 갈리면 AI가 자기 차례에 기권해 대국을 끝낸다(캐주얼 UX).
  // 추정 점수(scoreBoard)는 중반엔 노이즈가 있어 임계값을 크게(판 크기 비례) 두어
  // "정말 갈렸을 때"만 발동시킨다.
  function aiShouldResign() {
    if (state.moveNumber < state.size * 2) return false; // 초반엔 추정이 불안정
    const s = scoreBoard();
    const aiScore = state.ai === BLACK ? s.black : s.white;
    const oppScore = state.ai === BLACK ? s.white : s.black;
    const behindBy = oppScore - aiScore;
    const threshold = Math.max(18, state.size * state.size * 0.22);
    return behindBy >= threshold;
  }

  function aiResign() {
    state.ended = true;
    state.resigned = state.ai;
    state.result = scoreBoard();
    state.resultDismissed = false;
    state.thinking = false;
    state.aiProposing = false;
    render();
  }

  function undo() {
    if (!state.history.length || state.thinking || state.phase !== "play") return;
    restore(state.history.pop());
    if (state.history.length && state.turn === state.ai) restore(state.history.pop());
    render();
  }

  function restore(prev) {
    state.lastCaptured = [];
    state.lastEvent = "";
    state.hint = null;
    Object.assign(state, {
      board: prev.board,
      turn: prev.turn,
      moveNumber: prev.moveNumber,
      captures: prev.captures,
      lastMove: prev.lastMove,
      lastWasPass: prev.lastWasPass,
      passes: prev.passes,
      koKey: prev.koKey,
      ended: prev.ended,
      resigned: prev.resigned,
      result: prev.result,
      resultDismissed: prev.resultDismissed || false,
    });
  }

  function isLegal(x, y) {
    if (state.board[y][x] !== EMPTY) return false;
    const temp = {
      board: state.board,
      turn: state.turn,
      size: state.size,
      koKey: state.koKey,
    };
    return legalOn(temp, x, y);
  }

  function legalOn(pos, x, y) {
    if (pos.board[y][x] !== EMPTY) return false;
    const color = pos.turn;
    const opp = color === BLACK ? WHITE : BLACK;
    const next = cloneBoard(pos.board);
    next[y][x] = color;
    for (const [nx, ny] of neighbors(x, y, pos.size)) {
      if (next[ny][nx] === opp) {
        const group = getGroup(next, nx, ny);
        if (group.liberties.size === 0) {
          for (const [sx, sy] of group.stones) next[sy][sx] = EMPTY;
        }
      }
    }
    if (getGroup(next, x, y).liberties.size === 0) return false;
    return !(pos.koKey && boardKey(next) === pos.koKey);
  }

  function legalMoves() {
    const moves = [];
    for (let y = 0; y < state.size; y += 1) {
      for (let x = 0; x < state.size; x += 1) {
        if (isLegal(x, y)) moves.push([x, y]);
      }
    }
    return moves;
  }

  function scoreBoard() {
    // 죽은 돌(state.deadStones)은 빈 점으로 쳐 영역을 계산하고, 상대 포로에 가산한다.
    const dead = state.deadStones || new Set();
    const at = (x, y) => (dead.has(`${x},${y}`) ? EMPTY : state.board[y][x]);
    let deadBlack = 0;
    let deadWhite = 0;
    for (const key of dead) {
      const [sx, sy] = key.split(",").map(Number);
      if (state.board[sy][sx] === BLACK) deadBlack += 1;
      else if (state.board[sy][sx] === WHITE) deadWhite += 1;
    }

    const visited = new Set();
    const territory = { 1: 0, 2: 0 };

    for (let y = 0; y < state.size; y += 1) {
      for (let x = 0; x < state.size; x += 1) {
        if (at(x, y) !== EMPTY || visited.has(`${x},${y}`)) continue;
        const region = [];
        const borders = new Set();
        const stack = [[x, y]];
        visited.add(`${x},${y}`);
        while (stack.length) {
          const [cx, cy] = stack.pop();
          region.push([cx, cy]);
          for (const [nx, ny] of neighbors(cx, cy)) {
            const value = at(nx, ny);
            if (value === EMPTY) {
              const key = `${nx},${ny}`;
              if (!visited.has(key)) {
                visited.add(key);
                stack.push([nx, ny]);
              }
            } else {
              borders.add(value);
            }
          }
        }
        if (borders.size === 1) territory[[...borders][0]] += region.length;
      }
    }

    const prisoners = {
      [BLACK]: state.captures[BLACK] + deadWhite,
      [WHITE]: state.captures[WHITE] + deadBlack,
    };
    const black = territory[BLACK] + prisoners[BLACK];
    const white = territory[WHITE] + prisoners[WHITE] + komiFor(state.size);
    return {
      territory,
      prisoners,
      black,
      white,
      winner: black > white ? BLACK : WHITE,
      margin: Math.abs(black - white),
    };
  }

  // 끝난 판에서 죽은 돌을 추정한다. 완벽하진 않으니(세키·옥집 등은 예외) 사람이 탭으로 보정한다.
  // 규칙: 한 그룹이 자기 색으로만 둘러싸인 빈 영역(=눈/집)을 2곳 이상 끼고 있거나,
  // 그런 영역 한 곳이라도 6집 이상이면 산 것으로 보고, 그 외에는 죽은 것으로 본다.
  function detectDeadStones(board) {
    const size = board.length;

    // 1) 빈 영역마다 "그 영역에 닿는 돌 색이 한 가지뿐인지(soleColor)"와 크기를 구한다.
    const regionOf = new Map();
    const regions = [];
    const seen = new Set();
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (board[y][x] !== EMPTY || seen.has(`${x},${y}`)) continue;
        const cells = [];
        const borders = new Set();
        const stack = [[x, y]];
        seen.add(`${x},${y}`);
        while (stack.length) {
          const [cx, cy] = stack.pop();
          cells.push([cx, cy]);
          for (const [nx, ny] of neighbors(cx, cy, size)) {
            const v = board[ny][nx];
            if (v === EMPTY) {
              const k = `${nx},${ny}`;
              if (!seen.has(k)) { seen.add(k); stack.push([nx, ny]); }
            } else borders.add(v);
          }
        }
        const idx = regions.length;
        regions.push({ soleColor: borders.size === 1 ? [...borders][0] : 0, size: cells.length });
        for (const [cx, cy] of cells) regionOf.set(`${cx},${cy}`, idx);
      }
    }

    // 2) 각 그룹이 자기 색 전용 눈 영역을 몇 곳 끼고 있는지로 삶/죽음을 판정한다.
    const dead = new Set();
    const processed = new Set();
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const color = board[y][x];
        if (!color || processed.has(`${x},${y}`)) continue;
        const group = getGroup(board, x, y);
        for (const [sx, sy] of group.stones) processed.add(`${sx},${sy}`);

        const eyeIds = new Set();
        for (const lib of group.liberties) {
          const idx = regionOf.get(lib);
          if (idx !== undefined && regions[idx].soleColor === color) eyeIds.add(idx);
        }
        let alive = eyeIds.size >= 2;
        if (!alive && eyeIds.size === 1 && regions[[...eyeIds][0]].size >= 6) alive = true;
        if (!alive) for (const [sx, sy] of group.stones) dead.add(`${sx},${sy}`);
      }
    }
    return dead;
  }

  // 종국: 죽은 돌을 자동 추정해 곧장 채점·결과까지 간다(마킹 관문 없음).
  // 판정이 이상하면 결과 화면에서 [더 두기]로 이어 두거나 [판정 고치기]로 보정한다.
  function autoFinish(notice) {
    if (state.ended || state.phase !== "play") return;
    state.aiProposing = false;
    state.deadStones = detectDeadStones(state.board);
    state.phase = "ended";
    state.ended = true;
    state.result = scoreBoard();
    state.resultDismissed = false;
    state.endingNotice = notice || "";
  }

  function chooseMove() {
    const moves = legalMoves();
    if (!moves.length) return null;
    if (state.difficulty === "easy") {
      const filtered = moves.filter(([x, y]) => !isOwnEye(x, y));
      const pool = filtered.length ? filtered : moves;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    let best = null;
    let bestScore = -Infinity;
    const sample = state.difficulty === "hard" ? moves : moves.filter((_, i) => i % 2 === 0 || moves.length < 120);
    for (const move of sample) {
      const score = evaluateMove(move[0], move[1]) + Math.random() * 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
    }
    return bestScore < -8 ? null : best;
  }

  function isOwnEye(x, y) {
    const color = state.turn;
    let friendly = 0;
    let offBoard = 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) offBoard += 1;
      else if (state.board[ny][nx] === color) friendly += 1;
    }
    return friendly + offBoard === 4;
  }

  function evaluateMove(x, y) {
    const color = state.turn;
    const opp = color === BLACK ? WHITE : BLACK;
    const next = cloneBoard(state.board);
    next[y][x] = color;
    let score = 0;
    let captured = 0;
    let atari = 0;

    for (const [nx, ny] of neighbors(x, y)) {
      if (next[ny][nx] !== opp) continue;
      const group = getGroup(next, nx, ny);
      if (group.liberties.size === 0) {
        captured += group.stones.length;
        for (const [sx, sy] of group.stones) next[sy][sx] = EMPTY;
      } else if (group.liberties.size === 1) {
        atari += 1;
      }
    }
    score += captured * (state.difficulty === "hard" ? 16 : 11);
    score += atari * (state.difficulty === "hard" ? 5 : 3);

    const own = getGroup(next, x, y);
    if (own.liberties.size <= 1) score -= state.difficulty === "hard" ? 12 : 7;
    score += Math.min(own.liberties.size, 5) * 0.9;

    let friendly = 0;
    let opponent = 0;
    for (const [nx, ny] of neighbors(x, y)) {
      if (state.board[ny][nx] === color) {
        friendly += 1;
        const old = getGroup(state.board, nx, ny);
        if (old.liberties.size === 1) score += 10;
      }
      if (state.board[ny][nx] === opp) opponent += 1;
    }
    score += friendly * 1.1 + opponent * 0.8;

    if (state.lastMove) {
      const d = Math.max(Math.abs(x - state.lastMove[0]), Math.abs(y - state.lastMove[1]));
      if (d === 1) score += 2.1;
      else if (d === 2) score += 1.2;
      else if (d === 3) score += 0.5;
    }

    const edgeDist = Math.min(x, y, state.size - 1 - x, state.size - 1 - y);
    if (state.moveNumber < state.size * 2) {
      if (edgeDist === 2 || edgeDist === 3) score += 2.3;
      if (edgeDist === 0) score -= 6;
      if (edgeDist === 1) score -= 1.5;
    }
    score += starPointBonus(x, y);

    if (state.difficulty === "hard") {
      score += influenceScore(next, x, y, color) * 0.55;
    }

    return score;
  }

  function starPointBonus(x, y) {
    const stars = starPoints(state.size);
    return stars.some(([sx, sy]) => sx === x && sy === y) && state.moveNumber < state.size ? 3 : 0;
  }

  function influenceScore(board, x, y, color) {
    let score = 0;
    for (let cy = Math.max(0, y - 3); cy <= Math.min(state.size - 1, y + 3); cy += 1) {
      for (let cx = Math.max(0, x - 3); cx <= Math.min(state.size - 1, x + 3); cx += 1) {
        const d = Math.max(Math.abs(cx - x), Math.abs(cy - y));
        if (d === 0) continue;
        if (board[cy][cx] === color) score += 1 / d;
        else if (board[cy][cx]) score -= 0.7 / d;
      }
    }
    return score;
  }

  function starPoints(size) {
    if (size === 5) return [[2,2]];
    if (size === 9) return [[2,2], [6,2], [4,4], [2,6], [6,6]];
    if (size === 13) return [[3,3], [9,3], [6,6], [3,9], [9,9]];
    return [[3,3],[9,3],[15,3],[3,9],[9,9],[15,9],[3,15],[9,15],[15,15]];
  }

  function newGame(options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, "size")) {
      state.size = Number(options.size);
    }
    state.human = options.human || state.human;
    state.ai = state.human === BLACK ? WHITE : BLACK;
    state.difficulty = options.difficulty || state.difficulty;
    state.theme = options.theme || state.theme;
    if (Object.prototype.hasOwnProperty.call(options, "started")) state.started = options.started;
    if (Object.prototype.hasOwnProperty.call(options, "mobileStarted")) {
      state.mobileStarted = options.mobileStarted;
    }
    state.board = emptyBoard(state.size);
    state.turn = BLACK;
    state.moveNumber = 0;
    state.captures = { 1: 0, 2: 0 };
    state.history = [];
    state.lastMove = null;
    state.lastCaptured = [];
    state.lastCapturedAt = 0;
    state.lastEvent = "";
    state.lastWasPass = false;
    state.passes = 0;
    state.koKey = null;
    state.ended = false;
    state.resigned = null;
    state.timeoutLoser = null;
    state.phase = "play";
    state.deadStones = new Set();
    state.endProposalCooldown = 0;
    state.endingNotice = "";
    state.aiProposing = false;
    state.result = null;
    state.resultDismissed = false;
    state.thinking = false;
    state.error = "";
    state.blackTime = timeBudget(state.size);
    state.whiteTime = timeBudget(state.size);
    state.hint = null;
    state.hintsUsed = 0;
    state.confirm = null;
    state.sheetOpen = false;
    render();
    if (state.started) maybeAi();
  }

  function humanPlay(x, y) {
    if (state.phase === "marking") {
      toggleDeadGroup(x, y);
      return;
    }
    if (state.ended || state.thinking || state.turn !== state.human) return;
    const result = place(x, y);
    if (!result.ok) {
      showError(result.reason);
      return;
    }
    render();
    maybeAi();
  }

  function proposeEnding() {
    if (state.ended || state.phase !== "play") return;
    if (state.thinking) return;
    if (state.moveNumber < state.size * state.size * 0.25) {
      state.endingNotice = "아직 종국하기엔 일러요. 조금 더 둔 뒤 다시 시도해주세요.";
      window.clearTimeout(proposeEnding.timer);
      proposeEnding.timer = window.setTimeout(() => {
        state.endingNotice = "";
        render();
      }, 2200);
      render();
      return;
    }
    if (aiAgreesToEnd()) {
      autoFinish("이제 둘 곳이 거의 없어 종국했어요.");
    } else {
      state.endProposalCooldown = 8;
      state.endingNotice = "AI가 아직 둘 곳이 있대요. 조금 더 둔 뒤 다시 끝내기를 눌러주세요.";
      window.clearTimeout(proposeEnding.timer);
      proposeEnding.timer = window.setTimeout(() => {
        state.endingNotice = "";
        render();
      }, 2400);
    }
    render();
  }

  function aiAgreesToEnd() {
    if (state.moveNumber < state.size * state.size * 0.25) return false;
    const moves = legalMoves();
    if (moves.length < 4) return true;
    // 빈 칸 위치 점수(evaluateMove)는 거의 모든 자리가 높게 나와 종국 감지에 쓸 수 없다.
    // 대신 "실제로 무언가를 해내는 수"가 남았는지로 판단한다. 그런 수가 없으면 종국 제안.
    return !hasMeaningfulMoves(moves);
  }

  // 종국 판정용: 잡기/단수/내 돌 살리기/경계 줄이기 같은 "의미 있는 수"가 하나라도 남았는지.
  // 빈 땅 메우기(자기 집)나 공배(dame)만 남았으면 의미 있는 수가 없는 것으로 본다.
  function hasMeaningfulMoves(moves) {
    const color = state.turn;
    const opp = color === BLACK ? WHITE : BLACK;
    for (const [x, y] of moves) {
      const next = cloneBoard(state.board);
      next[y][x] = color;
      // ① 상대 돌을 잡거나 단수로 모는 수
      for (const [nx, ny] of neighbors(x, y)) {
        if (next[ny][nx] === opp && getGroup(next, nx, ny).liberties.size <= 1) return true;
      }
      // ② 단수에 몰린 내 돌을 살리는 수(놓은 뒤 활로가 2개 이상으로 늘어나면 구제로 본다)
      for (const [nx, ny] of neighbors(x, y)) {
        if (state.board[ny][nx] === color
          && getGroup(state.board, nx, ny).liberties.size === 1
          && getGroup(next, x, y).liberties.size > 1) return true;
      }
      // ③ 상대와 맞닿아 있으면서 빈 공간을 낀 경계 다툼(침투·삭감)
      let touchesOpp = false;
      let openSpace = false;
      for (const [nx, ny] of neighbors(x, y)) {
        if (state.board[ny][nx] === opp) touchesOpp = true;
        else if (state.board[ny][nx] === EMPTY) openSpace = true;
      }
      if (touchesOpp && openSpace) return true;
    }
    return false;
  }

  function toggleDeadGroup(x, y) {
    if (state.phase !== "marking") return;
    if (!inBounds(x, y)) return;
    const value = state.board[y][x];
    if (!value) return;
    const group = getGroup(state.board, x, y);
    const firstKey = `${group.stones[0][0]},${group.stones[0][1]}`;
    const isDead = state.deadStones.has(firstKey);
    for (const [sx, sy] of group.stones) {
      const key = `${sx},${sy}`;
      if (isDead) state.deadStones.delete(key);
      else state.deadStones.add(key);
    }
    render();
  }

  function cancelMarking() {
    state.phase = "play";
    state.deadStones = new Set();
    state.endingNotice = "";
    render();
  }

  // 마킹 보정 후 재채점. 보드는 건드리지 않고 죽은 돌 표시(state.deadStones)만 반영한다.
  function confirmMarking() {
    state.phase = "ended";
    state.ended = true;
    state.result = scoreBoard();
    state.resultDismissed = false;
    state.endingNotice = "";
    render();
  }

  // 결과 화면 [더 두기]: 종국을 취소하고 그대로 이어서 둔다(COSUMI식 분쟁 해결).
  function resumePlay() {
    state.phase = "play";
    state.ended = false;
    state.resigned = null;
    state.result = null;
    state.resultDismissed = false;
    state.deadStones = new Set();
    state.passes = 0;
    state.endProposalCooldown = 8;
    state.endingNotice = "이어서 둘게요.";
    render();
  }

  // 결과 화면 [판정 고치기]: 죽은 돌 표시를 탭으로 보정하는 마킹 단계로(자동 추정 유지).
  function reopenMarking() {
    state.phase = "marking";
    state.ended = false;
    state.result = null;
    state.resultDismissed = false;
    state.endingNotice = "죽은 돌을 탭해서 고친 뒤 [채점하기]를 누르세요.";
    render();
  }

  function maybeAi() {
    if (state.ended || state.turn !== state.ai || state.thinking || state.phase !== "play") return;
    state.thinking = true;
    render();
    const delay = state.difficulty === "easy" ? 360 : state.difficulty === "medium" ? 720 : 1100;
    window.setTimeout(() => {
      if (aiShouldResign()) { aiResign(); return; }
      const move = chooseMove();
      if (move) place(move[0], move[1]);
      else pass();
      state.thinking = false;
      maybeAiProposeEnd();
      render();
    }, delay);
  }

  function maybeAiProposeEnd() {
    if (state.ended || state.phase !== "play" || state.aiProposing) return;
    if (state.endProposalCooldown > 0) {
      state.endProposalCooldown -= 1;
      return;
    }
    if (aiAgreesToEnd()) {
      state.aiProposing = true;
    }
  }

  function showError(reason) {
    const text = {
      occupied: "이미 돌이 놓여 있어요",
      suicide: "자살수는 둘 수 없어요",
      ko: "패(劫) 규칙으로 바로 둘 수 없어요",
      ended: "대국이 종료되었어요",
      out: "둘 수 없는 자리예요",
    }[reason] || "둘 수 없는 자리예요";
    state.error = text;
    render();
    window.clearTimeout(showError.id);
    showError.id = window.setTimeout(() => {
      state.error = "";
      render();
    }, 1400);
  }

  function formatTime(total) {
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function coord(x, y) {
    return `${COLS[x]}${state.size - y}`;
  }

  function icon(name) {
    const paths = {
      play: '<path d="M7 5l12 7-12 7V5z" fill="currentColor"/>',
      back: '<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
      undo: '<path d="M3 7v6h6M3 13a9 9 0 1 0 3-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
      pass: '<path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
      flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
      refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
      bulb: '<path d="M9 21h6M10 18h4M12 3a6 6 0 0 0-3.5 10.9c.8.6 1.2 1.4 1.4 2.1h4.2c.2-.7.6-1.5 1.4-2.1A6 6 0 0 0 12 3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
      more: '<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>',
      end: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
      check: '<path d="M5 12l5 5L20 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      x: '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
  }

  function chip(color, size = 16) {
    return `<span class="stone-chip ${color === BLACK ? "black" : "white"}" style="width:${size}px;height:${size}px"></span>`;
  }

  function playerCard(color) {
    const isAi = color === state.ai;
    const active = state.turn === color && !state.ended;
    const name = isAi ? `AI · ${DIFFICULTY_COPY[state.difficulty].title}` : escapeHtml(state.playerName || "나");
    const captured = state.captures[color];
    const oppColor = color === BLACK ? WHITE : BLACK;
    const trayChips = Array.from({ length: Math.min(captured, 8) }, () => chip(oppColor, 12)).join("");
    const overflow = captured > 8 ? `<span class="tray-more">+${captured - 8}</span>` : "";
    const thinkingLabel = isAi
      ? (state.thinking ? "AI가 한 수 고르는 중" : "AI 차례")
      : "내 차례 · 좋은 자리에 두세요";
    return `
      <section class="player ${active ? "active" : ""} ${active && state.thinking && isAi ? "thinking-on" : ""}">
        <div class="player-main">
          <div class="avatar">${chip(color, 28)}</div>
          <div class="player-info">
            <div class="name-row">
              <span class="name">${name}</span>
              ${isAi ? '<span class="tag">AI</span>' : ""}
            </div>
            <div class="sub">잡은 돌 <b>${captured}</b></div>
          </div>
          <div class="clock">${formatTime(color === BLACK ? state.blackTime : state.whiteTime)}</div>
        </div>
        ${captured ? `<div class="captures-tray" aria-label="잡은 돌 ${captured}개">${trayChips}${overflow}</div>` : ""}
        ${active ? `<div class="thinking"><i></i><i></i><i></i><span>${thinkingLabel}</span></div>` : ""}
      </section>
    `;
  }

  function boardHtml() {
    const size = state.size;
    const p = (i) => ((i + 0.5) / size) * 100;
    const lines = [];
    for (let i = 0; i < size; i += 1) {
      lines.push(`<line x1="${p(0)}%" y1="${p(i)}%" x2="${p(size - 1)}%" y2="${p(i)}%"></line>`);
      lines.push(`<line x1="${p(i)}%" y1="${p(0)}%" x2="${p(i)}%" y2="${p(size - 1)}%"></line>`);
    }
    const coordsX = Array.from({ length: size }, (_, i) => `<span style="left:${p(i)}%">${COLS[i]}</span>`).join("");
    const coordsY = Array.from({ length: size }, (_, i) => `<span style="top:${p(i)}%">${size - i}</span>`).join("");
    const stars = starPoints(size).map(([x, y]) => `<span class="star" style="left:${p(x)}%;top:${p(y)}%"></span>`).join("");
    const stones = [];
    const hits = [];
    const captureFlash = state.lastCaptured && state.lastCaptured.length && Date.now() - state.lastCapturedAt < 600
      ? state.lastCaptured.map(([cx, cy]) => `<span class="capture-flash" style="left:${p(cx)}%;top:${p(cy)}%"></span>`).join("")
      : "";
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const value = state.board[y][x];
        const left = p(x);
        const top = p(y);
        if (value) {
          const last = state.lastMove && state.lastMove[0] === x && state.lastMove[1] === y;
          const placing = last ? " placing" : "";
          const dead = state.deadStones.has(`${x},${y}`) ? " dead" : "";
          stones.push(`<span class="stone ${value === BLACK ? "black" : "white"}${last && state.showLast ? " last" : ""}${placing}${dead}" style="left:${left}%;top:${top}%"></span>`);
        }
        const hitClass = state.phase === "marking" && value ? "hit hit-mark" : "hit";
        hits.push(`<button class="${hitClass}" data-x="${x}" data-y="${y}" aria-label="${coord(x, y)}" style="left:${left}%;top:${top}%"></button>`);
      }
    }
    const hint = state.hint
      ? `<span class="hint-marker" style="left:${p(state.hint[0])}%;top:${p(state.hint[1])}%"></span>`
      : "";
    return `
      <div class="board-shell" style="--size:${size}">
        ${state.showCoords ? `<div class="coords coords-x">${coordsX}</div><div class="coords coords-y">${coordsY}</div>` : ""}
        <div class="board ${state.theme}">
          <div class="board-bg"></div>
          <svg class="line-layer" preserveAspectRatio="none">${lines.join("")}</svg>
          ${stars}
          ${stones.join("")}
          ${captureFlash}
          ${hint}
          ${hits.join("")}
        </div>
        ${state.error ? `<div class="toast">${state.error}</div>` : ""}
      </div>
    `;
  }

  function contextualTip() {
    if (!state.started) return TIPS_OPENING[0];
    if (state.phase === "marking") {
      return `상대 색의 죽은 돌을 탭하면 사석으로 표시됩니다. 모두 표시했으면 [채점하기]를 누르세요.`;
    }
    if (state.lastEvent && state.lastEvent.startsWith("capture:")) {
      const [, color, count] = state.lastEvent.split(":");
      const me = Number(color) === state.human;
      const ico = me ? "icons/party-popper.svg" : "icons/triangle-alert.svg";
      const text = me
        ? `잡았어요! 돌 ${count}개 획득. 이 흐름을 이어가요.`
        : `${count}개를 잡혔어요. 한 발 물러서서 다시 정비해요.`;
      return `<span class="tone-${me ? "gold" : "red"}">${lucide(ico)}</span> ${text}`;
    }
    const phase = state.moveNumber < state.size * 1.5 ? TIPS_OPENING
      : state.moveNumber < state.size * 4 ? TIPS_MIDGAME
      : TIPS_ENDGAME;
    return phase[Math.floor(state.moveNumber / 3) % phase.length];
  }

  function moveLog() {
    const moves = [];
    for (let i = 1; i < state.history.length; i += 1) {
      const snap = state.history[i];
      if (snap.lastMove) moves.push(snap.lastMove);
    }
    if (state.lastMove) moves.push(state.lastMove);
    if (!moves.length) return '<div class="empty">아직 둔 수가 없어요.</div>';
    return moves.map((m, i) => `
      <div class="move">
        <span class="move-num">${i + 1}</span>
        ${chip(m[2], 14)}
        <span>${coord(m[0], m[1])}</span>
      </div>
    `).join("");
  }

  function controls() {
    return `
      <div class="card settings-card">
        <div class="card-head"><h3>다음 대국</h3><span class="muted-tiny">시작 시 적용</span></div>
        ${seg("내 색", "next-human", String(state.human), [[String(BLACK),"흑 (선)"],[String(WHITE),"백 (후)"]])}
        <button class="btn primary icon full" data-restart>${icon("refresh")} 새 대국 시작</button>
      </div>
      <div class="card kbd-card">
        <div class="card-head"><h3>단축키</h3></div>
        <div class="kbd-grid">
          <div><kbd>P</kbd><span>패스</span></div>
          <div><kbd>U</kbd><span>되돌리기</span></div>
          <div><kbd>H</kbd><span>힌트</span></div>
          <div><kbd>N</kbd><span>새 대국</span></div>
        </div>
      </div>
    `;
  }

  const START_PRESETS = [
    { size: 5,  difficulty: "easy",   label: "입문", spec: "5 × 5",   time: "약 1분" },
    { size: 9,  difficulty: "medium", label: "보통", spec: "9 × 9",   time: "약 5분" },
    { size: 19, difficulty: "hard",   label: "정식", spec: "19 × 19", time: "약 20분" },
  ];

  function startView() {
    const current = START_PRESETS.find((p) => p.size === state.size) || START_PRESETS[0];
    const presets = START_PRESETS.map((p) => `
      <button class="seg-preset ${state.size === p.size ? "selected" : ""}" data-setting="preset" data-value="${p.size}">
        <b>${p.label}</b><small>${p.spec}</small>
      </button>`).join("");
    return `
      <section class="start-view simple" aria-label="대국 시작 화면">
        <div class="start-hero-block">
          <div class="game-emblem" aria-hidden="true">
            <span class="emblem-stone black"></span>
            <span class="emblem-stone white"></span>
          </div>
          <h1 class="game-title">바둑</h1>
          <p class="game-tagline">AI와 두는 한 판.<br>집을 더 많이 차지하면 이겨요.</p>
        </div>
        <div class="start-controls">
          <div class="seg-presets" role="group" aria-label="난이도와 판 크기">
            ${presets}
          </div>
          <div class="seg-presets seg-colors" role="group" aria-label="내 색">
            <button class="seg-preset ${state.human === BLACK ? "selected" : ""}" data-setting="human" data-value="${BLACK}">
              <span class="seg-stone black"></span><b>흑</b><small>내가 먼저</small>
            </button>
            <button class="seg-preset ${state.human === WHITE ? "selected" : ""}" data-setting="human" data-value="${WHITE}">
              <span class="seg-stone white"></span><b>백</b><small>AI가 먼저</small>
            </button>
          </div>
          <p class="start-meta">AI ${DIFFICULTY_COPY[current.difficulty].title} · 한 판에 ${current.time}</p>
          <button class="start-cta" data-start>${icon("play")} 대국 시작</button>
          <button class="start-secondary" data-tutorial-open>${icon("bulb")} 규칙 보기</button>
        </div>
      </section>
    `;
  }

  function colorOption(color) {
    const isBlack = color === BLACK;
    return `
      <button class="opt color ${state.human === color ? "selected" : ""}" data-setting="human" data-value="${color}">
        ${chip(color, 40)}
        <b>${isBlack ? "흑 (선)" : "백 (후)"}</b>
        <small>${isBlack ? "내가 먼저" : "AI가 먼저"}</small>
      </button>
    `;
  }

  function sizeOption(size) {
    const meta = SIZE_COPY[size];
    return `
      <button class="opt size ${state.size === size ? "selected" : ""}" data-setting="size" data-value="${size}">
        <b>${meta.title}</b>
        <small>${meta.sub}</small>
      </button>
    `;
  }

  function difficultyOption(key) {
    const meta = DIFFICULTY_COPY[key];
    return `
      <button class="opt row ${state.difficulty === key ? "selected" : ""}" data-setting="difficulty" data-value="${key}">
        <span class="opt-text"><b>${meta.title}</b><small>${meta.sub}</small></span>
        <span class="opt-radio"><i></i></span>
      </button>
    `;
  }

  function seg(label, key, selected, options) {
    return `
      <div class="control">
        <div class="label"><span>${label}</span></div>
        <div class="seg" style="--cols:${options.length}">
          ${options.map(([value, text]) => `<button data-setting="${key}" data-value="${value}" class="${selected === value ? "selected" : ""}">${text}</button>`).join("")}
        </div>
      </div>
    `;
  }

  function toggle(label, key, on) {
    return `
      <div class="toggle-row">
        <span>${label}</span>
        <button class="toggle ${on ? "on" : ""}" data-toggle="${key}" aria-label="${label}"><i></i></button>
      </div>
    `;
  }

  function resultModal() {
    if (!state.ended || state.resultDismissed) return "";
    const result = state.result || scoreBoard();
    const resigned = state.resigned;
    const timeout = state.timeoutLoser;
    const winner = resigned
      ? (resigned === BLACK ? WHITE : BLACK)
      : timeout
        ? (timeout === BLACK ? WHITE : BLACK)
        : result.winner;
    const humanWon = winner === state.human;
    const title = resigned
      ? `${winner === BLACK ? "흑" : "백"} 승리 (기권)`
      : timeout
        ? `${winner === BLACK ? "흑" : "백"} 시간승`
        : `${winner === BLACK ? "흑" : "백"} ${result.margin.toFixed(1)}집 승`;
    const headlineIcon = humanWon ? "icons/party-popper.svg" : "icons/hand-shake.svg";
    const headlineText = humanWon ? "축하해요, 이겼어요!" : "좋은 한 판이었어요";
    const headline = `<span class="tone-${humanWon ? "gold" : "blue"}">${lucide(headlineIcon)}</span> ${headlineText}`;
    const body = resigned
      ? (resigned === state.human ? "기권하셨어요. 다음 판에서 다시 만나요." : "AI가 기권했어요!")
      : timeout
        ? (timeout === state.human ? "제한 시간이 끝났어요." : "AI 제한 시간이 끝났어요!")
        : `영역 + 포로 + 백 덤 ${komiFor(state.size)}집 합산.`;
    const tBlack = result.territory ? result.territory[BLACK] : 0;
    const tWhite = result.territory ? result.territory[WHITE] : 0;
    return `
      <div class="modal-scrim" data-close-modal>
        <div class="modal result" role="dialog" aria-modal="true" aria-labelledby="result-title">
          <div class="result-trophy">${chip(winner, 58)}</div>
          <div class="result-headline">${headline}</div>
          <h2 id="result-title">${title}</h2>
          <p class="muted">${body}</p>
          <div class="score">
            <div class="score-box ${winner === BLACK ? "winner" : ""}">
              <div class="score-name">${chip(BLACK, 14)} 흑</div>
              <div class="score-total">${result.black.toFixed(1)}</div>
              <div class="score-detail">집 ${tBlack} · 포로 ${result.prisoners ? result.prisoners[BLACK] : state.captures[BLACK]}</div>
            </div>
            <div class="score-box ${winner === WHITE ? "winner" : ""}">
              <div class="score-name">${chip(WHITE, 14)} 백</div>
              <div class="score-total">${result.white.toFixed(1)}</div>
              <div class="score-detail">집 ${tWhite} · 포로 ${result.prisoners ? result.prisoners[WHITE] : state.captures[WHITE]} · 덤 ${komiFor(state.size)}</div>
            </div>
          </div>
          ${!resigned && !timeout ? `
          <div class="result-redo">
            <span>결과가 이상한가요?</span>
            <button class="btn" data-fix-dead>판정 고치기</button>
            <button class="btn" data-resume-play>더 두기</button>
          </div>` : ""}
          <div class="modal-actions">
            <button class="btn" data-close-result>판 살펴보기</button>
            <button class="btn primary icon" data-rematch>${icon("refresh")} 다시 한 판</button>
          </div>
        </div>
      </div>
    `;
  }

  function confirmModal() {
    if (!state.confirm) return "";
    const c = state.confirm;
    return `
      <div class="modal-scrim" data-confirm-cancel>
        <div class="modal confirm" role="alertdialog" aria-modal="true">
          <h2>${c.title}</h2>
          <p class="muted">${c.body}</p>
          <div class="modal-actions">
            <button class="btn" data-confirm-cancel>${c.cancel || "취소"}</button>
            <button class="btn ${c.danger ? "danger-fill" : "primary"} icon" data-confirm-ok>${c.confirm}</button>
          </div>
        </div>
      </div>
    `;
  }

  function mobileSheet() {
    if (!state.sheetOpen) return "";
    const hintLeft = HINT_LIMIT - state.hintsUsed;
    return `
      <div class="sheet-scrim" data-sheet-close>
        <div class="sheet" role="dialog" aria-modal="true">
          <div class="sheet-handle"></div>
          <div class="sheet-head"><h3>대국 메뉴</h3></div>
          <div class="sheet-grid">
            <button class="sheet-action primary" data-propose-end ${state.ended || state.phase !== "play" || state.thinking ? "disabled" : ""}>
              ${icon("end")}<b>끝내기 제안</b><small>AI에게 종국 제안</small>
            </button>
            <button class="sheet-action" data-hint ${hintLeft && !state.ended && state.turn === state.human && !state.thinking && state.phase === "play" ? "" : "disabled"}>
              <span class="sheet-icon tone-blue">${lucide("icons/lightbulb.svg")}</span><b>힌트</b><small>${hintLeft}회 남음</small>
            </button>
            <button class="sheet-action" data-undo ${state.history.length && state.phase === "play" ? "" : "disabled"}>
              ${icon("undo")}<b>되돌리기</b><small>한 수 취소</small>
            </button>
            <button class="sheet-action" data-pass ${state.ended || state.thinking || state.turn !== state.human || state.phase !== "play" ? "disabled" : ""}>
              ${icon("pass")}<b>패스</b><small>한 수 건너뛰기</small>
            </button>
            <button class="sheet-action danger" data-resign ${state.ended || state.phase !== "play" ? "disabled" : ""}>
              ${icon("flag")}<b>기권</b><small>이번 판 포기</small>
            </button>
          </div>
          <div class="sheet-section">
            <h4>표시</h4>
            ${seg("보드", "theme", state.theme, [["wood","나무"],["paper","종이"],["dark","다크"]])}
            ${toggle("좌표 표시", "coords", state.showCoords)}
            ${toggle("마지막 수 표시", "last", state.showLast)}
          </div>
          <button class="sheet-cta" data-rematch>${icon("refresh")} 새 대국 시작</button>
        </div>
      </div>
    `;
  }

  function tBoard(size, stones, marks = []) {
    const cell = 100 / size;
    const half = cell / 2;
    const r = cell * 0.42;
    const lines = [];
    for (let i = 0; i < size; i += 1) {
      const pos = half + i * cell;
      lines.push(`<line x1="${half}" y1="${pos}" x2="${100 - half}" y2="${pos}" stroke="rgba(40,24,8,.7)" stroke-width=".4"/>`);
      lines.push(`<line x1="${pos}" y1="${half}" x2="${pos}" y2="${100 - half}" stroke="rgba(40,24,8,.7)" stroke-width=".4"/>`);
    }
    const stoneEls = stones.map(([x, y, c]) => {
      const cx = half + x * cell;
      const cy = half + y * cell;
      return c === BLACK
        ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#171719"/>`
        : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="#bfbfbf" stroke-width=".25"/>`;
    }).join("");
    const markEls = marks.map(([x, y, type]) => {
      const cx = half + x * cell;
      const cy = half + y * cell;
      if (type === "x") {
        const m = cell * 0.22;
        return `<g stroke="#ff4242" stroke-width=".7" stroke-linecap="round"><line x1="${cx-m}" y1="${cy-m}" x2="${cx+m}" y2="${cy+m}"/><line x1="${cx-m}" y1="${cy+m}" x2="${cx+m}" y2="${cy-m}"/></g>`;
      }
      if (type === "dot") return `<circle cx="${cx}" cy="${cy}" r="${cell*0.13}" fill="#0066ff"/>`;
      if (type === "ring") return `<circle cx="${cx}" cy="${cy}" r="${cell*0.36}" fill="none" stroke="#0066ff" stroke-width=".6"/>`;
      if (type === "blackArea") return `<circle cx="${cx}" cy="${cy}" r="${cell*0.18}" fill="#171719" opacity=".55"/>`;
      if (type === "whiteArea") return `<circle cx="${cx}" cy="${cy}" r="${cell*0.18}" fill="#fff" stroke="#888" stroke-width=".25" opacity=".75"/>`;
      return "";
    }).join("");
    return `
      <svg class="t-board-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
        <rect width="100" height="100" rx="3" fill="#e6c178"/>
        ${lines.join("")}
        ${stoneEls}
        ${markEls}
      </svg>
    `;
  }

  function tutorialView() {
    if (!state.tutorialOpen) return "";
    return `
      <div class="modal-scrim tutorial-scrim" data-tutorial-close>
        <div class="tutorial" role="dialog" aria-modal="true" aria-labelledby="tutorial-title">
          <header class="tutorial-head">
            <div>
              <div class="tutorial-kicker">바둑 입문</div>
              <h2 id="tutorial-title">1분 안내</h2>
            </div>
            <button class="mobile-icon-btn" data-tutorial-close aria-label="닫기">${icon("x")}</button>
          </header>
          <div class="tutorial-body">
            <section class="t-section">
              <h3 class="t-num">01</h3>
              <h4>한 줄 요약</h4>
              <p>바둑은 <b>빈 공간을 자기 색 돌로 둘러싸 영토(집)를 더 많이 차지</b>한 쪽이 이기는 게임이에요. 체스처럼 왕을 잡는 게 아니에요.</p>
            </section>

            <section class="t-section">
              <h3 class="t-num">02</h3>
              <h4>착수의 기본</h4>
              <div class="t-row">
                <div class="t-board">${tBoard(5, [[2,2,BLACK]])}</div>
                <div class="t-text">
                  <p>돌은 <b>선이 만나는 교차점</b>에 놓아요. 칸 안이 아닙니다.</p>
                  <p><b>흑이 먼저</b> 두고, 한 수씩 번갈아가며 둬요. 한 번 놓은 돌은 옮길 수 없어요.</p>
                </div>
              </div>
            </section>

            <section class="t-section">
              <h3 class="t-num">03</h3>
              <h4>활로(liberty)와 잡기</h4>
              <div class="t-row">
                <div class="t-board">${tBoard(5, [[2,2,WHITE],[1,2,BLACK],[3,2,BLACK],[2,1,BLACK]], [[2,3,"dot"]])}</div>
                <div class="t-text">
                  <p>돌은 인접한 빈 점(상하좌우)이 있어야 살아 있어요. 이걸 <b>활로</b>라고 합니다.</p>
                  <p>왼쪽 백돌은 활로가 1개(파란 점) 남았어요. 흑이 그 자리에 두면 백은 활로가 0이 돼서 <b>잡혀</b> 보드에서 사라져요.</p>
                </div>
              </div>
              <div class="t-row reverse">
                <div class="t-board">${tBoard(5, [[1,2,BLACK],[3,2,BLACK],[2,1,BLACK],[2,3,BLACK]], [[2,2,"x"]])}</div>
                <div class="t-text">
                  <p>이렇게 잡힌 돌은 보드에서 제거되고 <b>"잡은 돌"</b>로 카운트돼요. 게임 끝에 점수에 더해집니다.</p>
                </div>
              </div>
            </section>

            <section class="t-section">
              <h3 class="t-num">04</h3>
              <h4>그룹과 두 눈</h4>
              <div class="t-row">
                <div class="t-board">${tBoard(7, [
                  [2,2,WHITE],[3,2,WHITE],[4,2,WHITE],[2,3,WHITE],[4,3,WHITE],[2,4,WHITE],[3,4,WHITE],[4,4,WHITE],
                  [1,2,BLACK],[1,3,BLACK],[1,4,BLACK],[5,2,BLACK],[5,3,BLACK],[5,4,BLACK],[2,1,BLACK],[3,1,BLACK],[4,1,BLACK],[2,5,BLACK],[3,5,BLACK],[4,5,BLACK],
                ], [[3,3,"ring"]])}</div>
                <div class="t-text">
                  <p><b>같은 색 돌이 붙어 있으면 한 그룹</b>이에요. 같이 살고 같이 죽어요.</p>
                  <p>왼쪽 백 그룹은 안에 빈 점이 1개(파란 동그라미)뿐. 흑이 거기 두면 그룹 전체가 잡혀요.</p>
                </div>
              </div>
              <div class="t-row reverse">
                <div class="t-board">${tBoard(7, [
                  [2,2,WHITE],[3,2,WHITE],[4,2,WHITE],[2,3,WHITE],[4,3,WHITE],[2,4,WHITE],[3,4,WHITE],[4,4,WHITE],[3,5,WHITE],
                  [1,2,BLACK],[1,3,BLACK],[1,4,BLACK],[1,5,BLACK],[5,2,BLACK],[5,3,BLACK],[5,4,BLACK],[5,5,BLACK],[2,1,BLACK],[3,1,BLACK],[4,1,BLACK],[2,5,BLACK],[2,6,BLACK],[3,6,BLACK],[4,6,BLACK],[4,5,BLACK],
                ], [[3,3,"ring"],[3,5,"ring"]])}</div>
                <div class="t-text">
                  <p>그룹 안에 <b>빈 점이 2개 따로</b> 있으면 <b>두 눈</b>이라고 부르고, 영원히 잡히지 않아요. 입문자가 가장 먼저 익혀야 할 개념이에요.</p>
                </div>
              </div>
            </section>

            <section class="t-section">
              <h3 class="t-num">05</h3>
              <h4>패(劫) 규칙</h4>
              <div class="t-row">
                <div class="t-board">${tBoard(5, [[1,2,BLACK],[2,1,BLACK],[2,3,BLACK],[3,1,WHITE],[3,3,WHITE],[4,2,WHITE]], [[3,2,"dot"]])}</div>
                <div class="t-text">
                  <p>방금 한 점 잡힌 모양을 <b>바로 되받아 잡는 건 금지</b>예요. 같은 모양이 무한 반복되는 걸 막기 위해서.</p>
                  <p>다른 곳에 한 수 둔 다음 차례에 다시 시도할 수 있어요.</p>
                </div>
              </div>
            </section>

            <section class="t-section">
              <h3 class="t-num">06</h3>
              <h4>한 판의 흐름</h4>
              <ul class="t-list">
                <li><b>포석</b> — 모서리 → 변 → 중앙 순으로 큰 자리 차지</li>
                <li><b>중반</b> — 영역을 다투고, 공격하면서 자기 집도 키움</li>
                <li><b>끝내기</b> — 큰 곳부터 작은 곳으로 마무리</li>
                <li><b>종국</b> — 두 사람이 합의하면 채점</li>
              </ul>
            </section>

            <section class="t-section">
              <h3 class="t-num">07</h3>
              <h4>종국과 채점</h4>
              <div class="t-row">
                <div class="t-board">${tBoard(9, [
                  [1,1,BLACK],[2,1,BLACK],[3,1,BLACK],[1,2,BLACK],[3,2,BLACK],[1,3,BLACK],[2,3,BLACK],[3,3,BLACK],
                  [5,5,WHITE],[6,5,WHITE],[7,5,WHITE],[5,6,WHITE],[7,6,WHITE],[5,7,WHITE],[6,7,WHITE],[7,7,WHITE],
                ], [
                  [2,2,"blackArea"],
                  [6,6,"whiteArea"],
                ])}</div>
                <div class="t-text">
                  <p>둘 다 더 둘 곳이 없으면 <b>끝내기</b> 버튼으로 합의 후 채점.</p>
                  <p><b>집(영역) + 잡은 돌 + 백 덤 6.5집</b>을 합산해 더 많은 쪽이 승리해요.</p>
                  <p class="muted-tiny">예: 흑 53집, 백 56.5집 → 백 3.5집 승</p>
                </div>
              </div>
            </section>
          </div>
          <footer class="tutorial-foot">
            <button class="btn icon" data-tutorial-close>${icon("play")} 한 판 두러 가기</button>
            <p class="tutorial-foot-note">시작 화면으로 돌아가요. 9 x 9 빠른 한 판부터 추천드려요.</p>
          </footer>
        </div>
      </div>
    `;
  }

  function liveScoreBlock() {
    if (state.moveNumber < 4) return "";
    const s = scoreBoard();
    const lead = s.black === s.white ? null : (s.black > s.white ? BLACK : WHITE);
    const margin = Math.abs(s.black - s.white).toFixed(1);
    const total = s.black + s.white;
    const blackPct = total > 0 ? (s.black / total) * 100 : 50;
    return `
      <div class="live-score">
        <div class="live-score-head">
          <span class="muted">실시간 추정</span>
          ${lead ? `<span class="value"><span class="tone-${lead === state.human ? "blue" : "red"}">${lead === BLACK ? "흑" : "백"} ${margin}집 우세</span></span>` : '<span class="value muted">백중세</span>'}
        </div>
        <div class="live-score-bar">
          <span class="bar-black" style="width:${blackPct}%"></span>
          <span class="bar-white" style="width:${100 - blackPct}%"></span>
        </div>
        <div class="live-score-foot">
          <span>${chip(BLACK, 10)} ${s.black.toFixed(0)}</span>
          <span>${chip(WHITE, 10)} ${s.white.toFixed(1)} <small>(덤 ${komiFor(state.size)})</small></span>
        </div>
      </div>
    `;
  }

  function endingBanner() {
    if (state.phase === "marking") {
      const deadCount = state.deadStones.size;
      return `
        <div class="ending-banner marking">
          <span class="ending-banner-title">${icon("end")} 종국 채점 단계</span>
          <span class="ending-banner-body">${deadCount ? `AI가 죽은 돌 ${deadCount}개를 표시했어요(빨강).` : "죽은 돌이 없다고 봤어요."} 틀린 곳은 탭해서 고친 뒤, 아래 파란 <b>채점하기</b> 버튼을 누르세요.</span>
        </div>
      `;
    }
    if (state.aiProposing) {
      return `
        <div class="ending-banner ai-propose">
          <div class="ai-propose-text">
            <span class="ending-banner-title">${icon("end")} AI가 종국을 제안해요</span>
            <span class="ending-banner-body">"이제 더 둘 게 없어 보여요." 마무리할까요?</span>
          </div>
          <div class="ai-propose-actions">
            <button class="btn" data-ai-end-decline>${icon("x")} 한 수 더</button>
            <button class="btn primary" data-ai-end-accept>${icon("check")} 끝내기</button>
          </div>
        </div>
      `;
    }
    if (state.endingNotice) {
      return `<div class="ending-banner notice">${state.endingNotice}</div>`;
    }
    return "";
  }

  function playActions(hintLeft) {
    const playable = !state.ended && !state.thinking && state.turn === state.human && state.phase === "play";
    return `
      <div class="actions">
        <button class="btn icon" data-hint ${hintLeft && playable ? "" : "disabled"}>${lucide("icons/lightbulb.svg")} 힌트 ${hintLeft}/${HINT_LIMIT}</button>
        <button class="btn icon" data-undo ${state.history.length && state.phase === "play" ? "" : "disabled"}>${icon("undo")} 되돌리기</button>
        <button class="btn primary icon" data-propose-end ${state.ended || state.phase !== "play" || state.thinking ? "disabled" : ""}>${icon("end")} 끝내기</button>
        <button class="btn danger icon" data-resign ${state.ended || state.phase !== "play" ? "disabled" : ""}>${icon("flag")} 기권</button>
        <span class="divider"></span>
        <button class="btn icon" data-rematch>${icon("refresh")} 새 대국</button>
      </div>
    `;
  }

  function markingActions() {
    return `
      <div class="marking-actions">
        <button class="mark-secondary" data-mark-cancel>${icon("x")} 더 둘게요</button>
        <button class="mark-confirm" data-mark-confirm>${icon("check")} 채점하기</button>
      </div>
    `;
  }

  function gameTopMeta() {
    const meta = DIFFICULTY_COPY[state.difficulty];
    return `
      <div class="meta-pills">
        <span class="pill blue">${state.size} x ${state.size}</span>
        <span class="pill">${meta.title}</span>
        <span class="pill"><i class="dot ${state.ended ? "ended" : "live"}"></i>${state.ended ? "종료" : "진행 중"}</span>
      </div>
    `;
  }

  function render() {
    const hintLeft = HINT_LIMIT - state.hintsUsed;
    const tipKind = state.lastEvent && state.lastEvent.startsWith("capture:") ? "event" : "phase";
    app.innerHTML = `
      <div class="app ${state.started ? "playing" : "setup"}">
        ${state.started ? "" : startView()}
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark"></div>
            <div>
              <div class="brand-title">바둑</div>
              <div class="brand-sub">Baduk · 圍棋</div>
            </div>
          </div>
          <div class="nav-spacer"></div>
          ${gameTopMeta()}
        </header>
        <header class="mobile-game-header">
          <button class="mobile-icon-btn" data-back-home aria-label="홈">${icon("back")}</button>
          <div class="mobile-game-title">
            <strong>${DIFFICULTY_COPY[state.difficulty].title}</strong>
            <span>${state.size} x ${state.size} · ${state.moveNumber}수</span>
          </div>
          <button class="mobile-icon-btn" data-sheet-open aria-label="메뉴">${icon("more")}</button>
        </header>
        <main class="layout">
          <aside class="side left">
            ${playerCard(BLACK)}
            ${playerCard(WHITE)}
            <section class="card move-log">
              <div class="card-head"><h3>수순</h3><span class="muted">${state.moveNumber}수</span></div>
              <div class="moves">${moveLog()}</div>
            </section>
          </aside>
          <section class="stage">
            ${endingBanner()}
            ${boardHtml()}
            ${state.phase === "marking" ? markingActions() : playActions(hintLeft)}
          </section>
          <aside class="side right">
            <section class="card status-card">
              <div class="card-head"><h3>상태</h3><span class="live"><i></i>${state.ended ? "종료" : "진행 중"}</span></div>
              <div class="rows">
                <div class="row"><span class="muted">차례</span><span class="value">${chip(state.turn, 16)} ${state.turn === BLACK ? "흑" : "백"}</span></div>
                <div class="row"><span class="muted">수</span><span class="value">${state.moveNumber}</span></div>
                <div class="row"><span class="muted">잡은 돌</span><span class="value">${chip(BLACK, 12)}${state.captures[BLACK]} ${chip(WHITE, 12)}${state.captures[WHITE]}</span></div>
                <div class="row"><span class="muted">단계</span><span class="value">${state.phase === "marking" ? "채점 중" : state.ended ? "종료" : "진행 중"}</span></div>
              </div>
              ${liveScoreBlock()}
            </section>
            ${controls()}
            <section class="card tip-card ${tipKind === "event" ? "tip-event" : ""}">
              <div class="card-head"><h3>${tipKind === "event" ? "방금 한 수" : "오늘의 한 수"}</h3></div>
              <p>${contextualTip()}</p>
            </section>
          </aside>
        </main>
        ${mobileSheet()}
        ${confirmModal()}
        ${resultModal()}
        ${tutorialView()}
      </div>
    `;
    bind();
  }

  function bind() {
    if (bind.attached) return;
    bind.attached = true;
    app.addEventListener("click", onAppClick);
    app.addEventListener("input", onAppInput);
  }

  function onAppClick(event) {
    const target = event.target;
    const hit = target.closest(".hit");
    if (hit) {
      humanPlay(Number(hit.dataset.x), Number(hit.dataset.y));
      return;
    }
    const node = target.closest(
      "[data-undo],[data-pass],[data-resign],[data-hint],[data-start],[data-rematch],[data-restart],[data-back-home],[data-sheet-open],[data-sheet-close],[data-confirm-cancel],[data-confirm-ok],[data-close-result],[data-close-modal],[data-resume-play],[data-fix-dead],[data-setting],[data-toggle],[data-propose-end],[data-mark-cancel],[data-mark-confirm],[data-ai-end-accept],[data-ai-end-decline],[data-tutorial-open],[data-tutorial-close]"
    );
    if (!node || node.disabled) return;
    const ds = node.dataset;
    let info = null;
    if (ds.setting !== undefined) info = { name: "setting", value: ds.value, key: ds.setting };
    else if (ds.toggle !== undefined) info = { name: "toggle", value: ds.toggle };
    else if ("undo" in ds) info = { name: "undo" };
    else if ("pass" in ds) info = { name: "pass" };
    else if ("resign" in ds) info = { name: "resign" };
    else if ("hint" in ds) info = { name: "hint" };
    else if ("start" in ds) info = { name: "start" };
    else if ("rematch" in ds) info = { name: "rematch" };
    else if ("restart" in ds) info = { name: "restart" };
    else if ("backHome" in ds) info = { name: "back-home" };
    else if ("proposeEnd" in ds) info = { name: "propose-end" };
    else if ("markCancel" in ds) info = { name: "mark-cancel" };
    else if ("markConfirm" in ds) info = { name: "mark-confirm" };
    else if ("aiEndAccept" in ds) info = { name: "ai-end-accept" };
    else if ("aiEndDecline" in ds) info = { name: "ai-end-decline" };
    else if ("tutorialOpen" in ds) info = { name: "tutorial-open" };
    else if ("tutorialClose" in ds) info = { name: "tutorial-close" };
    else if ("sheetOpen" in ds) info = { name: "sheet-open" };
    else if ("sheetClose" in ds) {
      if (target.closest(".sheet") && !target.matches("[data-sheet-close]")) return;
      info = { name: "sheet-close" };
    } else if ("confirmCancel" in ds) {
      if (target.closest(".modal") && !target.matches("[data-confirm-cancel]")) return;
      info = { name: "confirm-cancel" };
    } else if ("confirmOk" in ds) info = { name: "confirm-ok" };
    else if ("closeResult" in ds) info = { name: "close-result" };
    else if ("resumePlay" in ds) info = { name: "resume-play" };
    else if ("fixDead" in ds) info = { name: "fix-dead" };
    else if ("closeModal" in ds) {
      if (target.closest(".modal") && !target.matches("[data-close-result]")) return;
      info = { name: "close-modal" };
    }
    if (info) handleAction(info.name, info.value, info);
  }

  function handleAction(name, value, info) {
    if (name === "undo") { state.sheetOpen = false; undo(); return; }
    if (name === "pass") { state.sheetOpen = false; pass(); render(); maybeAi(); return; }
    if (name === "resign") {
      askConfirm({
        title: "정말 기권하시겠어요?",
        body: "이번 판은 종료되고 결과가 표시돼요.",
        confirm: "기권하기",
        danger: true,
        onConfirm: () => { state.sheetOpen = false; resign(); },
      });
      return;
    }
    if (name === "hint") { state.sheetOpen = false; showHint(); return; }
    if (name === "propose-end") { state.sheetOpen = false; proposeEnding(); return; }
    if (name === "mark-cancel") { cancelMarking(); return; }
    if (name === "mark-confirm") { confirmMarking(); return; }
    if (name === "ai-end-accept") {
      autoFinish("종국에 합의했어요.");
      render();
      return;
    }
    if (name === "resume-play") { resumePlay(); return; }
    if (name === "fix-dead") { reopenMarking(); return; }
    if (name === "ai-end-decline") {
      state.aiProposing = false;
      state.endProposalCooldown = 8;
      state.endingNotice = "그럼 한 수 더 둘게요.";
      window.clearTimeout(handleAction.declineTimer);
      handleAction.declineTimer = window.setTimeout(() => {
        state.endingNotice = "";
        render();
      }, 1800);
      render();
      return;
    }
    if (name === "tutorial-open") { state.tutorialOpen = true; render(); return; }
    if (name === "tutorial-close") { state.tutorialOpen = false; render(); return; }
    if (name === "start") {
      newGame({ human: state.human, difficulty: state.difficulty, started: true, mobileStarted: true });
      return;
    }
    if (name === "rematch" || name === "restart") {
      askConfirmIfMid({
        title: name === "restart" ? "새 설정으로 시작할까요?" : "새 대국을 시작할까요?",
        body: "지금까지의 대국이 사라져요.",
        confirm: "새로 시작",
        onConfirm: () => newGame({ started: true, mobileStarted: true, human: state.human }),
      });
      return;
    }
    if (name === "back-home") {
      askConfirmIfMid({
        title: "시작 화면으로 갈까요?",
        body: "지금까지의 대국이 사라져요.",
        confirm: "나가기",
        onConfirm: () => newGame({ started: false, mobileStarted: false }),
      });
      return;
    }
    if (name === "sheet-open") { state.sheetOpen = true; render(); return; }
    if (name === "sheet-close") { state.sheetOpen = false; render(); return; }
    if (name === "confirm-cancel") { state.confirm = null; render(); return; }
    if (name === "confirm-ok") {
      const onOk = state.confirm?.onConfirm;
      state.confirm = null;
      if (onOk) onOk();
      else render();
      return;
    }
    if (name === "close-result" || name === "close-modal") {
      state.resultDismissed = true;
      render();
      return;
    }
    if (name === "setting") {
      const key = info.key;
      if (key === "human") {
        if (state.started && state.moveNumber > 0 && !state.ended) {
          askConfirm({
            title: "색을 바꿀까요?",
            body: "지금까지의 대국이 사라지고 새 판으로 시작해요.",
            confirm: "색 바꾸고 새로 시작",
            onConfirm: () => newGame({ human: Number(value), started: true, mobileStarted: true }),
          });
        } else {
          state.human = Number(value);
          state.ai = state.human === BLACK ? WHITE : BLACK;
          if (state.started) {
            newGame({ human: state.human, started: true, mobileStarted: true });
          } else {
            render();
          }
        }
      } else if (key === "next-human") {
        askConfirmIfMid({
          title: "색을 바꿀까요?",
          body: "지금까지의 대국이 사라지고 새 판으로 시작해요.",
          confirm: "색 바꾸고 새로 시작",
          onConfirm: () => newGame({ human: Number(value), started: true, mobileStarted: true }),
        });
      } else if (key === "size") {
        if (state.started && state.moveNumber > 0 && !state.ended) {
          askConfirm({
            title: "판 크기를 바꿀까요?",
            body: "지금까지의 대국이 사라지고 새 판으로 시작해요.",
            confirm: "바꾸고 새로 시작",
            onConfirm: () => newGame({ size: Number(value), started: true, mobileStarted: true }),
          });
        } else {
          state.size = Number(value);
          if (state.started) {
            newGame({ size: state.size, started: true, mobileStarted: true });
          } else {
            newGame({ size: state.size, started: false, mobileStarted: false });
          }
        }
      } else if (key === "preset") {
        const preset = START_PRESETS.find((p) => p.size === Number(value)) || START_PRESETS[0];
        const apply = () => {
          newGame({
            size: preset.size,
            difficulty: preset.difficulty,
            human: state.human,
            started: state.started,
            mobileStarted: state.started,
          });
        };
        if (state.started && state.moveNumber > 0 && !state.ended) {
          askConfirm({
            title: "난이도를 바꿀까요?",
            body: "지금까지의 대국이 사라지고 새 판으로 시작해요.",
            confirm: "바꾸고 새로 시작",
            onConfirm: apply,
          });
        } else {
          apply();
        }
      } else if (key === "difficulty") {
        state.difficulty = value;
        render();
      } else if (key === "theme") {
        state.theme = value;
        render();
      }
      return;
    }
    if (name === "toggle") {
      if (value === "coords") state.showCoords = !state.showCoords;
      if (value === "last") state.showLast = !state.showLast;
      render();
    }
  }

  function onAppInput(event) {
    if (event.target.id !== "player-name") return;
    state.playerName = event.target.value;
    document.querySelectorAll(".player .name").forEach((el) => {
      if (!el.textContent.startsWith("AI")) el.textContent = state.playerName || "나";
    });
  }

  function askConfirm(c) {
    state.confirm = c;
    render();
  }

  function askConfirmIfMid(c) {
    if (!state.started || state.ended || state.moveNumber === 0) {
      c.onConfirm();
      return;
    }
    askConfirm(c);
  }

  function showHint() {
    if (state.ended || state.thinking || state.turn !== state.human || state.phase !== "play") return;
    if (state.hintsUsed >= HINT_LIMIT) return;
    const move = chooseMove();
    if (!move) return;
    state.hint = move;
    state.hintsUsed += 1;
    render();
    window.clearTimeout(showHint.timer);
    showHint.timer = window.setTimeout(() => {
      state.hint = null;
      render();
    }, 2400);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  document.addEventListener("keydown", (event) => {
    if (/input|textarea|select/i.test(event.target.tagName)) return;
    if (state.confirm || state.sheetOpen) {
      if (event.key === "Escape") {
        state.confirm = null;
        state.sheetOpen = false;
        render();
      }
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "p") $("[data-pass]")?.click();
    if (key === "u") $("[data-undo]")?.click();
    if (key === "h") $("[data-hint]")?.click();
    if (key === "n") $("[data-rematch]")?.click();
  });

  function startTimerLoop() {
    if (state.timer) return;
    state.timer = window.setInterval(() => {
      if (!state.started || state.ended || state.confirm) return;
      if (state.phase === "marking") return;
      if (state.turn === BLACK) state.blackTime = Math.max(0, state.blackTime - 1);
      else state.whiteTime = Math.max(0, state.whiteTime - 1);
      if (state.blackTime === 0 || state.whiteTime === 0) {
        finishByTimeout(state.blackTime === 0 ? BLACK : WHITE);
        state.sheetOpen = false;
        render();
        return;
      }
      if (state.sheetOpen) return;
      render();
    }, 1000);
  }

  function finishByTimeout(loserColor) {
    state.ended = true;
    state.timeoutLoser = loserColor;
    state.result = scoreBoard();
    state.resultDismissed = false;
  }

  newGame({ human: BLACK, size: 9, difficulty: "easy", started: false, mobileStarted: false });
  startTimerLoop();
})();
