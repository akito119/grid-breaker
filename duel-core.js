export const DUEL_DEFAULT_SETTINGS = Object.freeze({
  maxTurns: 5,
  maxHp: 100,
  maxMp: 80,
  tokenLimit: 4,
  wallLimit: 8,
  wallPlacementSeconds: 45,
  methodBuildSeconds: 180,
  tokenPlacementSeconds: 60,
  gridSize: 12,
});

export const DUEL_SETTING_LIMITS = Object.freeze({
  maxTurns: [1, 20],
  maxHp: [10, 1000],
  maxMp: [1, 10_000],
  tokenLimit: [1, 12],
  wallLimit: [0, 100],
  wallPlacementSeconds: [10, 300],
  methodBuildSeconds: [30, 900],
  tokenPlacementSeconds: [15, 300],
  gridSize: [6, 30],
});

export const DUEL_LANGUAGE_BASELINES = Object.freeze({
  python: { timeMs: 1.2, memoryKb: 12_500 },
  cpp: { timeMs: 0.35, memoryKb: 4_500 },
  java: { timeMs: 1.0, memoryKb: 36_000 },
});

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function boundedInteger(value, [min, max], fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return clamp(number, min, max);
}

export function sanitizeRoomSettings(input = {}) {
  const settings = {};
  for (const [key, fallback] of Object.entries(DUEL_DEFAULT_SETTINGS)) {
    settings[key] = boundedInteger(input[key], DUEL_SETTING_LIMITS[key], fallback);
  }
  const maximumUsefulWalls = settings.gridSize * settings.gridSize - 2;
  settings.wallLimit = Math.min(settings.wallLimit, maximumUsefulWalls);
  return settings;
}

export function cellKey(row, col) {
  return `${row},${col}`;
}

export function inBounds(size, row, col) {
  return Number.isInteger(row) && Number.isInteger(col)
    && row >= 0 && row < size && col >= 0 && col < size;
}

export function transformCell(size, cell, side) {
  const row = Number(cell?.[0]);
  const col = Number(cell?.[1]);
  return side === "B" ? [size - 1 - row, size - 1 - col] : [row, col];
}

export function transformCells(size, cells, side) {
  return (Array.isArray(cells) ? cells : []).map((cell) => transformCell(size, cell, side));
}

export function isDeploymentCell(size, side, row, col) {
  if (!inBounds(size, row, col)) return false;
  const half = Math.floor(size / 2);
  return side === "A" ? col < half : col >= size - half;
}

function freeCellsConnected(size, walls) {
  const wallSet = walls instanceof Set ? walls : new Set(walls);
  let start = null;
  let freeCount = 0;
  let aFree = 0;
  let bFree = 0;

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (wallSet.has(cellKey(row, col))) continue;
      freeCount += 1;
      if (!start) start = [row, col];
      if (isDeploymentCell(size, "A", row, col)) aFree += 1;
      if (isDeploymentCell(size, "B", row, col)) bFree += 1;
    }
  }
  if (!start || aFree === 0 || bFree === 0) return false;

  const visited = new Set([cellKey(...start)]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const [row, col] = queue[index];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nextRow = row + dr;
      const nextCol = col + dc;
      const key = cellKey(nextRow, nextCol);
      if (!inBounds(size, nextRow, nextCol) || wallSet.has(key) || visited.has(key)) continue;
      visited.add(key);
      queue.push([nextRow, nextCol]);
    }
  }
  return visited.size === freeCount;
}

function normalizeWallCandidates(size, candidates, side, wallLimit) {
  const result = [];
  const ownSeen = new Set();
  for (const value of Array.isArray(candidates) ? candidates.slice(0, wallLimit) : []) {
    if (!Array.isArray(value) || value.length !== 2) continue;
    const row = Number(value[0]);
    const col = Number(value[1]);
    if (!inBounds(size, row, col)) continue;
    const localKey = cellKey(row, col);
    if (ownSeen.has(localKey)) continue;
    ownSeen.add(localKey);
    result.push(transformCell(size, [row, col], side));
  }
  return result;
}

export function resolveWallCandidates({ size, wallLimit, turn, candidatesA, candidatesB }) {
  const normalized = {
    A: normalizeWallCandidates(size, candidatesA, "A", wallLimit),
    B: normalizeWallCandidates(size, candidatesB, "B", wallLimit),
  };
  const first = turn % 2 === 1 ? "A" : "B";
  const second = first === "A" ? "B" : "A";
  const attempts = [];
  for (let index = 0; index < Math.max(normalized.A.length, normalized.B.length); index += 1) {
    for (const side of [first, second]) {
      if (normalized[side][index]) attempts.push({ side, index, cell: normalized[side][index] });
    }
  }

  const walls = new Set();
  const decisions = [];
  for (const attempt of attempts) {
    const [row, col] = attempt.cell;
    const key = cellKey(row, col);
    if (walls.has(key)) {
      decisions.push({ ...attempt, accepted: false, reason: "duplicate" });
      continue;
    }
    const tentative = new Set(walls);
    tentative.add(key);
    if (!freeCellsConnected(size, tentative)) {
      decisions.push({ ...attempt, accepted: false, reason: "disconnect" });
      continue;
    }
    walls.add(key);
    decisions.push({ ...attempt, accepted: true, reason: "accepted" });
  }

  return {
    walls: [...walls].map((key) => key.split(",").map(Number)),
    decisions,
  };
}

export function analyzeTraversal({ size, walls, start, path, maxOutputs = size * size * 4 }) {
  const wallSet = new Set((walls || []).map(([row, col]) => cellKey(row, col)));
  const attempts = [];
  const effectCells = [];
  let previous = [...start];
  const input = Array.isArray(path) ? path : [];

  for (let index = 0; index < Math.min(input.length, maxOutputs); index += 1) {
    const value = input[index];
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isInteger)) {
      return { valid: false, status: "invalid", reason: `${index + 1}回目のemitが整数座標ではありません。`, attempts, effectCells };
    }
    const cell = [value[0], value[1]];
    if (Math.abs(previous[0] - cell[0]) + Math.abs(previous[1] - cell[1]) !== 1) {
      return { valid: false, status: "invalid", reason: `${index + 1}回目のemitが直前のマスと隣接していません。`, attempts, effectCells };
    }
    attempts.push(cell);
    if (!inBounds(size, cell[0], cell[1])) {
      return { valid: true, status: "boundary", collision: cell, attempts, effectCells, end: previous };
    }
    if (wallSet.has(cellKey(...cell))) {
      return { valid: true, status: "wall", collision: cell, attempts, effectCells, end: previous };
    }
    effectCells.push(cell);
    previous = cell;
  }

  if (input.length > maxOutputs) {
    return { valid: false, status: "limit", reason: `emit上限 ${maxOutputs} を超えました。`, attempts, effectCells };
  }
  return { valid: true, status: "ok", attempts, effectCells, end: previous };
}

export function normalizedRuntime(language, timeMs) {
  const baseline = DUEL_LANGUAGE_BASELINES[language] || DUEL_LANGUAGE_BASELINES.python;
  return Math.max(0, Number(timeMs) || 0) / baseline.timeMs;
}

export function normalizedMemory(language, memoryKb) {
  const baseline = DUEL_LANGUAGE_BASELINES[language] || DUEL_LANGUAGE_BASELINES.python;
  return clamp(Math.max(0, Number(memoryKb) || 0) / baseline.memoryKb, 1, 8);
}

export function calculateMpCost({ language, effect, memoryKb, outputCount }) {
  const amount = Math.max(0, Number(effect) || 0);
  const outputs = Math.max(0, Number(outputCount) || 0);
  if (outputs === 0) return 0;
  return Math.ceil(amount * normalizedMemory(language, memoryKb) * outputs);
}

export function sumTokenHp(tokens) {
  return (tokens || []).reduce((sum, token) => sum + Math.max(0, Number(token.hp) || 0), 0);
}

export function fallbackPlacement({ size, side, walls, hp }) {
  const wallSet = new Set((walls || []).map(([row, col]) => cellKey(row, col)));
  const preferred = [Math.floor(size / 2), 0];
  const candidates = [preferred];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < Math.floor(size / 2); col += 1) candidates.push([row, col]);
  }
  const local = candidates.find(([row, col]) => {
    const canonical = transformCell(size, [row, col], side);
    return inBounds(size, row, col) && !wallSet.has(cellKey(...canonical));
  });
  if (!local) throw new Error("配置可能な通常マスがありません。");
  const [row, col] = transformCell(size, local, side);
  return [{ id: `${side}-fallback`, row, col, hp, methodId: null, order: 1, shield: 0, activated: false }];
}

export function validatePlacement({ size, side, walls, hp, tokenLimit, tokens, methodIds = [] }) {
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > tokenLimit) {
    return { valid: false, reason: `トークン数は1〜${tokenLimit}体にしてください。` };
  }
  const wallSet = new Set((walls || []).map(([row, col]) => cellKey(row, col)));
  const occupied = new Set();
  const orders = new Set();
  const allowedMethods = new Set(methodIds);
  const canonical = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] || {};
    const row = Number(token.row);
    const col = Number(token.col);
    const tokenHp = Number(token.hp);
    const order = Number(token.order);
    if (!inBounds(size, row, col) || col >= Math.floor(size / 2)) {
      return { valid: false, reason: `トークン${index + 1}が自陣の配置範囲外です。` };
    }
    if (!Number.isInteger(tokenHp) || tokenHp <= 0) return { valid: false, reason: `トークン${index + 1}のHPが不正です。` };
    if (!Number.isInteger(order) || order <= 0 || orders.has(order)) return { valid: false, reason: "処理順は重複しない正の整数にしてください。" };
    const [canonicalRow, canonicalCol] = transformCell(size, [row, col], side);
    const key = cellKey(canonicalRow, canonicalCol);
    if (wallSet.has(key)) return { valid: false, reason: `トークン${index + 1}は壁の上に配置できません。` };
    if (occupied.has(key)) return { valid: false, reason: "同じマスへ複数のトークンを配置できません。" };
    if (token.methodId && !allowedMethods.has(token.methodId)) return { valid: false, reason: `トークン${index + 1}のメソッドが存在しません。` };
    occupied.add(key);
    orders.add(order);
    canonical.push({
      id: String(token.id || `${side}-${index + 1}`),
      row: canonicalRow,
      col: canonicalCol,
      hp: tokenHp,
      methodId: token.methodId ? String(token.methodId) : null,
      order,
      shield: 0,
      activated: false,
    });
  }
  if (sumTokenHp(canonical) !== hp) return { valid: false, reason: `トークンHPの合計を現在HP ${hp} にしてください。` };
  canonical.sort((a, b) => a.order - b.order);
  return { valid: true, tokens: canonical };
}
