import { analyzeTraversal } from "./duel-core.js";
import { DUEL_LANGUAGES, buildDuelSource, createDuelWandboxRequest, parseDuelOutput } from "./duel-runners.js";

const input = {
  size: 8,
  walls: [[0, 4], [2, 2]],
  start: [0, 0],
  knownEnemies: [{ row: 3, col: 3, activated: false }],
  maxOutputs: 128,
};

for (const [language, config] of Object.entries(DUEL_LANGUAGES)) {
  process.stdout.write(`Testing duel ${config.label}... `);
  const nonce = `smoke${language}`;
  const source = buildDuelSource(language, config.template, input, nonce);
  const response = await fetch("https://wandbox.org/api/compile.json", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createDuelWandboxRequest(language, source)),
  });
  if (!response.ok) throw new Error(`${language}: HTTP ${response.status}`);
  const result = await response.json();
  if (String(result.status) !== "0") throw new Error(`${language}: ${result.compiler_error || result.compiler_message || result.program_error || `exit ${result.status}`}`);
  const parsed = parseDuelOutput(result.program_output, nonce);
  const traversal = analyzeTraversal({ ...input, path: parsed.path });
  if (!traversal.valid) throw new Error(`${language}: ${traversal.reason}`);
  console.log(`${parsed.path.length} outputs, ${parsed.status}, ${parsed.timeMs.toFixed(3)} ms, ${(parsed.memoryKb / 1024).toFixed(2)} MB`);
}

console.log("All duel Wandbox smoke tests passed.");
