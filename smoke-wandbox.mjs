import { createGame, validatePath } from "./game-core.js";
import { LANGUAGES, buildSource, createWandboxRequest, parseProgramOutput } from "./runners.js";

let seed = 314159265;
const game = createGame(() => {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 2 ** 32;
});

for (const [language, config] of Object.entries(LANGUAGES)) {
  process.stdout.write(`Testing ${config.label}... `);
  const source = buildSource(language, config.template, game);
  const response = await fetch("https://wandbox.org/api/compile.json", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createWandboxRequest(language, source)),
  });
  if (!response.ok) throw new Error(`${language}: HTTP ${response.status}`);
  const result = await response.json();
  if (String(result.status) !== "0") {
    throw new Error(`${language}: ${result.compiler_message || result.program_error || `exit ${result.status}`}`);
  }
  const parsed = parseProgramOutput(result.program_output);
  const validation = validatePath(parsed.path, game.current, game.rows, game.cols, game.stepLimit);
  if (!validation.valid) throw new Error(`${language}: ${validation.reason}`);
  console.log(`${parsed.path.length}/${game.stepLimit} steps, ${parsed.metrics.timeMs.toFixed(3)} ms, ${(parsed.metrics.memoryKb / 1024).toFixed(2)} MB`);
}

console.log("All Wandbox smoke tests passed.");
