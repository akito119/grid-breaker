import assert from "node:assert/strict";
import {
  analyzeTraversal,
  calculateMpCost,
  fallbackPlacement,
  resolveWallCandidates,
  sanitizeRoomSettings,
  transformCell,
  validatePlacement,
} from "./duel-core.js";
import { DUEL_LANGUAGES, buildDuelSource, createDuelWandboxRequest, parseDuelOutput } from "./duel-runners.js";

const settings = sanitizeRoomSettings({ gridSize: 12, wallLimit: 999, maxHp: 100 });
assert.equal(settings.gridSize, 12);
assert.equal(settings.wallLimit, 100);
assert.deepEqual(transformCell(8, [1, 2], "A"), [1, 2]);
assert.deepEqual(transformCell(8, [1, 2], "B"), [6, 5]);

const walls = resolveWallCandidates({
  size: 6,
  wallLimit: 4,
  turn: 1,
  candidatesA: [[0, 2], [1, 2]],
  candidatesB: [[5, 3], [4, 3]],
});
assert.ok(walls.walls.length >= 2);
assert.equal(walls.decisions[0].side, "A");
assert.equal(walls.decisions[1].side, "B");

const collision = analyzeTraversal({
  size: 5,
  walls: [[0, 2]],
  start: [0, 0],
  path: [[0, 1], [0, 2], [0, 3]],
});
assert.equal(collision.valid, true);
assert.equal(collision.status, "wall");
assert.deepEqual(collision.attempts, [[0, 1], [0, 2]]);
assert.deepEqual(collision.effectCells, [[0, 1]]);

const boundary = analyzeTraversal({ size: 4, walls: [], start: [0, 0], path: [[-1, 0], [0, 0]] });
assert.equal(boundary.status, "boundary");
assert.equal(boundary.attempts.length, 1);
assert.equal(analyzeTraversal({ size: 4, walls: [], start: [0, 0], path: [[1, 1]] }).valid, false);

assert.equal(calculateMpCost({ language: "python", effect: 10, memoryKb: 12_500, outputCount: 3 }), 30);
assert.equal(calculateMpCost({ language: "python", effect: 10, memoryKb: 50_000, outputCount: 3 }), 120);

const placement = validatePlacement({
  size: 8,
  side: "B",
  walls: [[3, 3]],
  hp: 100,
  tokenLimit: 3,
  methodIds: ["m1"],
  tokens: [
    { id: "t1", row: 0, col: 0, hp: 60, methodId: "m1", order: 1 },
    { id: "t2", row: 1, col: 0, hp: 40, methodId: null, order: 2 },
  ],
});
assert.equal(placement.valid, true);
assert.deepEqual([placement.tokens[0].row, placement.tokens[0].col], [7, 7]);
assert.equal(validatePlacement({ size: 8, side: "A", walls: [], hp: 100, tokenLimit: 2, methodIds: [], tokens: [{ row: 0, col: 0, hp: 99, order: 1 }] }).valid, false);

const fallback = fallbackPlacement({ size: 8, side: "A", walls: [[4, 0]], hp: 50 });
assert.equal(fallback[0].hp, 50);
assert.notDeepEqual([fallback[0].row, fallback[0].col], [4, 0]);

for (const [language, config] of Object.entries(DUEL_LANGUAGES)) {
  const source = buildDuelSource(language, config.template, {
    size: 8,
    walls: [[1, 1]],
    start: [0, 0],
    knownEnemies: [{ row: 2, col: 2, activated: false }],
    maxOutputs: 64,
  }, "testnonce");
  assert.match(source, /__GBD_testnonce_BEGIN__/);
  assert.match(source, /__GBD_testnonce_RESULT__/);
  assert.equal(createDuelWandboxRequest(language, source).compiler, config.compiler);
}

const parsed = parseDuelOutput([
  "debug",
  "__GBD_abc_BEGIN__",
  "0 1",
  "0 2",
  "__GBD_abc_END__",
  "__GBD_abc_RESULT__ wall 0.250000 4096",
].join("\n"), "abc");
assert.deepEqual(parsed.path, [[0, 1], [0, 2]]);
assert.equal(parsed.status, "wall");
assert.equal(parsed.timeMs, 0.25);
assert.equal(parsed.memoryKb, 4096);

console.log("All GRID BREAKER duel unit tests passed.");
