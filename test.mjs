import assert from "node:assert/strict";
import {
  applyAttackPath,
  calculateClearScore,
  calculateDamage,
  calculateStepLimit,
  createGame,
  finishTurn,
  recordAttackStats,
  shortestVisitDistance,
  validatePath,
} from "./game-core.js";
import { LANGUAGES, buildSource, createWandboxRequest, parseProgramOutput } from "./runners.js";

function seededRandom(seed = 123456789) {
  let value = seed >>> 0;
  return () => {
    value = (1664525 * value + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

const generated = createGame(seededRandom());
assert.ok(generated.rows >= 8 && generated.rows <= 13);
assert.ok(generated.cols >= 10 && generated.cols <= 17);
assert.ok(generated.weakpointCount >= 3 && generated.weakpointCount <= 7);
assert.equal(new Set(generated.weakpoints.map((point) => `${point.row},${point.col}`)).size, generated.weakpointCount);
assert.ok(!generated.weakpoints.some((point) => point.row === generated.start[0] && point.col === generated.start[1]));

const targets = [
  { row: 0, col: 2 },
  { row: 2, col: 2 },
];
assert.equal(shortestVisitDistance([0, 0], targets), 4);
assert.equal(shortestVisitDistance([0, 0], [{ row: 0, col: 0 }]), 2);
assert.equal(calculateStepLimit([0, 0], targets), Math.ceil(4 * 1.35) + 2);

assert.deepEqual(
  validatePath([[0, 1], [1, 1], [1, 2]], [0, 0], 3, 3, 4),
  { valid: true, end: [1, 2], steps: 3 },
);
assert.match(validatePath([[1, 1]], [0, 0], 3, 3, 4).reason, /非隣接/);
assert.match(validatePath([[0, 0]], [0, 0], 3, 3, 4).reason, /待機/);
assert.match(validatePath([[0, -1]], [0, 0], 3, 3, 4).reason, /グリッド外/);
assert.match(validatePath([[0, 1], [0, 2]], [0, 0], 3, 3, 1).reason, /歩数上限/);

for (const language of Object.keys(LANGUAGES)) {
  const damage = calculateDamage({ language, codeBytes: 300, timeMs: 0.5, memoryKb: 8_000, hp: 300, maxTurns: 4 });
  assert.ok(Number.isInteger(damage) && damage >= 1);
  const source = buildSource(language, LANGUAGES[language].template, generated);
  assert.match(source, /__GB_PATH_BEGIN__/);
  assert.match(source, /__GB_METRICS__/);
  const request = createWandboxRequest(language, source);
  assert.equal(request.compiler, LANGUAGES[language].compiler);
}

const parsed = parseProgramOutput([
  "debug from user",
  "__GB_PATH_BEGIN__",
  "0 1",
  "1 1",
  "__GB_PATH_END__",
  "__GB_METRICS__ 0.123000 4096",
].join("\n"));
assert.deepEqual(parsed.path, [[0, 1], [1, 1]]);
assert.deepEqual(parsed.metrics, { timeMs: 0.123, memoryKb: 4096 });
assert.equal(parsed.userOutput, "debug from user");

const combat = {
  version: 2,
  rows: 3,
  cols: 3,
  weakpointCount: 1,
  hp: 100,
  maxTurns: 3,
  turn: 0,
  start: [0, 0],
  current: [0, 0],
  status: "playing",
  stepLimit: 5,
  weakpoints: [{ id: 1, row: 0, col: 1, hp: 100, maxHp: 100 }],
};
const hits = applyAttackPath(combat, [[0, 1], [0, 0], [0, 1]], 60);
assert.equal(hits.length, 2);
assert.equal(combat.weakpoints[0].hp, 0);
recordAttackStats(combat, {
  language: "python",
  codeBytes: 300,
  timeMs: 0.5,
  memoryKb: 8_000,
  steps: 3,
  hits: 2,
  damagePerHit: 60,
  damageDealt: 100,
});
assert.equal(finishTurn(combat, [0, 1]), "won");
const score = calculateClearScore(combat);
assert.equal(score.total, score.base + score.turnBonus + score.routeBonus + score.codeBonus + score.resourceBonus);
assert.ok(score.total >= 10_000);
assert.match(score.rank, /^[SABC]$/);

console.log("All GRID BREAKER unit tests passed.");
