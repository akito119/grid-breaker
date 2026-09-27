export const GAME_LIMITS = Object.freeze({
  rows: [8, 13],
  cols: [10, 17],
  weakpoints: [3, 7],
  hpUnits: [26, 42],
  turns: [3, 5],
});

export const LANGUAGE_BASELINES = Object.freeze({
  python: { code: 420, time: 1.2, memory: 12_500 },
  cpp: { code: 900, time: 0.35, memory: 4_500 },
  java: { code: 1_050, time: 1.0, memory: 36_000 },
});

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function randomInt(min, max, random = Math.random) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function randomPerimeterCell(rows, cols, random) {
  const perimeter = [];
  for (let col = 0; col < cols; col += 1) {
    perimeter.push([0, col]);
    if (rows > 1) perimeter.push([rows - 1, col]);
  }
  for (let row = 1; row < rows - 1; row += 1) {
    perimeter.push([row, 0]);
    if (cols > 1) perimeter.push([row, cols - 1]);
  }
  return perimeter[randomInt(0, perimeter.length - 1, random)];
}

export function createGame(random = Math.random) {
  const rows = randomInt(...GAME_LIMITS.rows, random);
  const cols = randomInt(...GAME_LIMITS.cols, random);
  const maxWeakpoints = Math.min(GAME_LIMITS.weakpoints[1], Math.floor(rows * cols / 12));
  const weakpointCount = randomInt(GAME_LIMITS.weakpoints[0], maxWeakpoints, random);
  const hp = randomInt(...GAME_LIMITS.hpUnits, random) * 10;
  const maxTurns = randomInt(...GAME_LIMITS.turns, random);
  const start = randomPerimeterCell(rows, cols, random);
  const occupied = new Set([start.join(",")]);
  const weakpoints = [];

  while (weakpoints.length < weakpointCount) {
    const row = randomInt(0, rows - 1, random);
    const col = randomInt(0, cols - 1, random);
    const key = `${row},${col}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    weakpoints.push({
      id: weakpoints.length + 1,
      row,
      col,
      hp,
      maxHp: hp,
    });
  }

  const game = {
    version: 2,
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    rows,
    cols,
    weakpointCount,
    hp,
    maxTurns,
    turn: 0,
    start,
    current: [...start],
    status: "playing",
    weakpoints,
    stats: { attacks: [] },
  };
  game.stepLimit = calculateStepLimit(game.current, livingWeakpoints(game));
  return game;
}

export function livingWeakpoints(game) {
  return game.weakpoints.filter((point) => point.hp > 0);
}

export function manhattan(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/**
 * Returns the shortest distance from start that visits every target and may end
 * at any target. A live target under the starting cell requires a two-step loop
 * so that it is actually re-entered rather than passively hit.
 */
export function shortestVisitDistance(start, targets) {
  const count = targets.length;
  if (count === 0) return 0;
  const states = 1 << count;
  const dp = Array.from({ length: states }, () => Array(count).fill(Infinity));

  for (let index = 0; index < count; index += 1) {
    const target = [targets[index].row, targets[index].col];
    const distance = manhattan(start, target);
    dp[1 << index][index] = distance === 0 ? 2 : distance;
  }

  for (let mask = 1; mask < states; mask += 1) {
    for (let last = 0; last < count; last += 1) {
      const current = dp[mask][last];
      if (!Number.isFinite(current)) continue;
      for (let next = 0; next < count; next += 1) {
        if (mask & (1 << next)) continue;
        const distance = Math.abs(targets[last].row - targets[next].row)
          + Math.abs(targets[last].col - targets[next].col);
        const nextMask = mask | (1 << next);
        dp[nextMask][next] = Math.min(dp[nextMask][next], current + distance);
      }
    }
  }

  return Math.min(...dp[states - 1]);
}

export function calculateStepLimit(start, targets) {
  if (targets.length === 0) return 0;
  const shortest = shortestVisitDistance(start, targets);
  return Math.ceil(shortest * 1.35) + targets.length;
}

export function validatePath(path, start, rows, cols, stepLimit) {
  if (!Array.isArray(path) || path.length === 0) {
    return { valid: false, index: 0, reason: "move(row, col) が1回も呼ばれていません。" };
  }
  if (path.length > stepLimit) {
    return {
      valid: false,
      index: stepLimit,
      reason: `歩数上限 ${stepLimit} を超えています（${path.length} steps）。`,
    };
  }

  let previous = start;
  for (let index = 0; index < path.length; index += 1) {
    const cell = path[index];
    if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isInteger)) {
      return { valid: false, index, reason: `${index + 1}手目の座標が整数ではありません。` };
    }
    const [row, col] = cell;
    if (row < 0 || row >= rows || col < 0 || col >= cols) {
      return { valid: false, index, reason: `${index + 1}手目 [${row}, ${col}] がグリッド外です。` };
    }
    const distance = manhattan(previous, cell);
    if (distance !== 1) {
      const kind = distance === 0 ? "同じセルでの待機" : "非隣接セルへの移動";
      return {
        valid: false,
        index,
        reason: `${index + 1}手目: ${kind} [${previous.join(", ")}] → [${cell.join(", ")}] は無効です。`,
      };
    }
    previous = cell;
  }
  return { valid: true, end: [...previous], steps: path.length };
}

export function calculateDamage({ language, codeBytes, timeMs, memoryKb, hp, maxTurns }) {
  const baseline = LANGUAGE_BASELINES[language];
  if (!baseline) throw new Error(`Unknown language: ${language}`);
  const base = Math.ceil((hp / maxTurns) * 1.2) + 22;
  const codeNormalized = Math.max(0.1, codeBytes / baseline.code);
  const timeNormalized = clamp(timeMs / baseline.time, 0.15, 8);
  const memoryNormalized = clamp(memoryKb / baseline.memory, 0.15, 4);
  const codePenalty = 12 * codeNormalized;
  const resourcePenalty = 6 * timeNormalized * memoryNormalized;
  return Math.max(1, Math.round(base - codePenalty - resourcePenalty));
}

export function applyAttackPath(game, path, damage) {
  const hits = [];
  path.forEach(([row, col], step) => {
    const point = game.weakpoints.find((candidate) => candidate.row === row && candidate.col === col && candidate.hp > 0);
    if (!point) return;
    const before = point.hp;
    point.hp = Math.max(0, point.hp - damage);
    hits.push({ step, id: point.id, row, col, before, after: point.hp, damage: Math.min(damage, before) });
  });
  return hits;
}

export function finishTurn(game, end) {
  game.turn += 1;
  game.current = [...end];
  const living = livingWeakpoints(game);
  if (living.length === 0) game.status = "won";
  else if (game.turn >= game.maxTurns) game.status = "lost";
  game.stepLimit = calculateStepLimit(game.current, living);
  return game.status;
}

export function totalHp(game) {
  return game.weakpoints.reduce((sum, point) => sum + point.hp, 0);
}

export function ensureGameStats(game) {
  if (!game.stats || !Array.isArray(game.stats.attacks)) {
    game.stats = { attacks: [] };
  }
  return game.stats;
}

export function recordAttackStats(game, attack) {
  const stats = ensureGameStats(game);
  stats.attacks.push({
    language: attack.language,
    codeBytes: attack.codeBytes,
    timeMs: attack.timeMs,
    memoryKb: attack.memoryKb,
    steps: attack.steps,
    hits: attack.hits,
    damagePerHit: attack.damagePerHit,
    damageDealt: attack.damageDealt,
  });
}

export function calculateClearScore(game) {
  const attacks = ensureGameStats(game).attacks;
  const count = Math.max(1, attacks.length);
  const totalSteps = attacks.reduce((sum, attack) => sum + attack.steps, 0);
  const totalHits = attacks.reduce((sum, attack) => sum + attack.hits, 0);
  const routeEfficiency = totalHits / Math.max(1, totalSteps);

  let codeRatioTotal = 0;
  let resourceRatioTotal = 0;
  for (const attack of attacks) {
    const baseline = LANGUAGE_BASELINES[attack.language] || LANGUAGE_BASELINES.python;
    codeRatioTotal += attack.codeBytes / baseline.code;
    const timeRatio = clamp(attack.timeMs / baseline.time, 0.15, 8);
    const memoryRatio = clamp(attack.memoryKb / baseline.memory, 0.15, 4);
    resourceRatioTotal += timeRatio * memoryRatio;
  }

  const averageCodeRatio = attacks.length ? codeRatioTotal / count : 2.2;
  const averageResourceRatio = attacks.length ? resourceRatioTotal / count : 2.5;
  const base = 10_000;
  const turnBonus = Math.max(0, game.maxTurns - game.turn) * 3_000;
  const routeBonus = Math.round(clamp(routeEfficiency / 0.22, 0, 1) * 4_000);
  const codeBonus = Math.round(clamp((2.2 - averageCodeRatio) / 1.7, 0, 1) * 3_000);
  const resourceBonus = Math.round(clamp((2.5 - averageResourceRatio) / 2.25, 0, 1) * 2_500);
  const total = base + turnBonus + routeBonus + codeBonus + resourceBonus;
  const rank = total >= 22_000 ? "S" : total >= 18_000 ? "A" : total >= 15_000 ? "B" : "C";

  return {
    total,
    rank,
    base,
    turnBonus,
    routeBonus,
    codeBonus,
    resourceBonus,
    turnsUsed: game.turn,
    routeEfficiency,
  };
}

export function isRecoverableGame(value) {
  return Boolean(
    value
      && value.version === 2
      && Number.isInteger(value.rows)
      && Number.isInteger(value.cols)
      && Array.isArray(value.current)
      && Array.isArray(value.weakpoints)
      && ["playing", "won", "lost"].includes(value.status),
  );
}
