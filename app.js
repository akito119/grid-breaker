import {
  LANGUAGE_BASELINES,
  calculateClearScore,
  calculateDamage,
  createGame,
  ensureGameStats,
  finishTurn,
  isRecoverableGame,
  livingWeakpoints,
  recordAttackStats,
  totalHp,
  validatePath,
} from "./game-core.js";
import {
  LANGUAGES,
  buildSource,
  createWandboxRequest,
  parseProgramOutput,
} from "./runners.js";

const WANDBOX_COMPILE_URL = "https://wandbox.org/api/compile.json";
const WANDBOX_LIST_URL = "https://wandbox.org/api/list.json";
const STORAGE_PREFIX = "grid-breaker:v2";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const ui = {
  canvas: $("#arena"),
  apiStatus: $("#apiStatus"),
  turnCurrent: $("#turnCurrent"),
  turnMax: $("#turnMax"),
  gridN: $("#gridN"),
  gridM: $("#gridM"),
  hitboxK: $("#hitboxK"),
  gridStat: $("#gridStat"),
  weakStat: $("#weakStat"),
  hpStat: $("#hpStat"),
  turnStat: $("#turnStat"),
  stepStat: $("#stepStat"),
  startStat: $("#startStat"),
  weakpointList: $("#weakpointList"),
  enemyHpText: $("#enemyHpText"),
  editorFallback: $("#editorFallback"),
  codeLength: $("#codeLength"),
  compilerLabel: $("#compilerLabel"),
  damagePreview: $("#damagePreview"),
  runButton: $("#runButton"),
  runButtonText: $("#runButtonText"),
  battleConsole: $("#battleConsole"),
  compilerConsole: $("#compilerConsole"),
  outputConsole: $("#outputConsole"),
  arenaMessage: $("#arenaMessage"),
  resultEyebrow: $("#resultEyebrow"),
  resultTitle: $("#resultTitle"),
  scorePanel: $("#scorePanel"),
  scoreRank: $("#scoreRank"),
  clearScore: $("#clearScore"),
  baseScore: $("#baseScore"),
  turnBonus: $("#turnBonus"),
  routeBonus: $("#routeBonus"),
  codeBonus: $("#codeBonus"),
  resourceBonus: $("#resourceBonus"),
  continueButton: $("#continueButton"),
  helpDialog: $("#helpDialog"),
};

const state = {
  language: localStorage.getItem(`${STORAGE_PREFIX}:language`) || "python",
  game: null,
  editor: null,
  running: false,
  trail: [],
  displayPosition: null,
  flash: null,
  animationToken: 0,
};

function gameStorageKey() { return `${STORAGE_PREFIX}:game`; }
function codeStorageKey(language = state.language) { return `${STORAGE_PREFIX}:code:${language}`; }

function loadGame() {
  try {
    const saved = JSON.parse(localStorage.getItem(gameStorageKey()));
    if (isRecoverableGame(saved)) {
      ensureGameStats(saved);
      return saved;
    }
  } catch {}
  return createGame();
}

function saveGame() {
  localStorage.setItem(gameStorageKey(), JSON.stringify(state.game));
}

function getCode() {
  return state.editor ? state.editor.getValue() : ui.editorFallback.value;
}

function setCode(value) {
  if (state.editor) state.editor.setValue(value);
  else ui.editorFallback.value = value;
  updateCodeStats();
}

function saveCode() {
  const code = getCode();
  if (code.trim()) localStorage.setItem(codeStorageKey(), code);
}

function utf8Length(value) {
  return new TextEncoder().encode(value).length;
}

function formatPosition(position) {
  return `[${position[0]}, ${position[1]}]`;
}

function updateCodeStats() {
  const codeBytes = utf8Length(getCode());
  ui.codeLength.textContent = `${codeBytes} bytes`;
  const baseline = LANGUAGE_BASELINES[state.language];
  const estimate = calculateDamage({
    language: state.language,
    codeBytes,
    timeMs: baseline.time,
    memoryKb: baseline.memory,
    hp: state.game.hp,
    maxTurns: state.game.maxTurns,
  });
  ui.damagePreview.textContent = `≈ ${estimate}`;
  saveCode();
}

function renderGame() {
  const game = state.game;
  const living = livingWeakpoints(game);
  ui.turnCurrent.textContent = game.turn;
  ui.turnMax.textContent = game.maxTurns;
  ui.gridN.textContent = game.rows;
  ui.gridM.textContent = game.cols;
  ui.hitboxK.textContent = game.weakpointCount;
  ui.gridStat.textContent = `${game.rows} × ${game.cols}`;
  ui.weakStat.textContent = `${living.length} / ${game.weakpointCount}`;
  ui.hpStat.textContent = game.hp;
  ui.turnStat.textContent = game.maxTurns;
  ui.stepStat.textContent = game.stepLimit;
  ui.startStat.textContent = formatPosition(game.current);
  ui.enemyHpText.textContent = `TOTAL HP ${totalHp(game)} / ${game.hp * game.weakpointCount}`;

  ui.weakpointList.innerHTML = game.weakpoints.map((point) => {
    const destroyed = point.hp <= 0;
    const percent = Math.max(0, (point.hp / point.maxHp) * 100);
    return `
      <div class="weakpoint-row">
        <span class="weakpoint-name ${destroyed ? "destroyed" : ""}">WP-${String(point.id).padStart(2, "0")} [${point.row}, ${point.col}]</span>
        <div class="hp-track"><div class="hp-fill ${destroyed ? "destroyed" : ""}" style="width:${percent}%"></div></div>
        <span class="weakpoint-hp">${point.hp} / ${point.maxHp}</span>
      </div>`;
  }).join("");

  ui.arenaMessage.classList.toggle("hidden", game.status === "playing");
  ui.arenaMessage.classList.toggle("lose", game.status === "lost");
  if (game.status === "won") {
    const score = calculateClearScore(game);
    ui.resultEyebrow.textContent = "MISSION COMPLETE";
    ui.resultTitle.textContent = "TARGET DOWN";
    ui.scoreRank.textContent = score.rank;
    ui.clearScore.textContent = score.total.toLocaleString("ja-JP");
    ui.baseScore.textContent = score.base.toLocaleString("ja-JP");
    ui.turnBonus.textContent = `+${score.turnBonus.toLocaleString("ja-JP")}`;
    ui.routeBonus.textContent = `+${score.routeBonus.toLocaleString("ja-JP")}`;
    ui.codeBonus.textContent = `+${score.codeBonus.toLocaleString("ja-JP")}`;
    ui.resourceBonus.textContent = `+${score.resourceBonus.toLocaleString("ja-JP")}`;
    ui.continueButton.querySelector("span").textContent = "CONTINUE";
    ui.continueButton.querySelector("small").textContent = "次の敵へ";
  } else if (game.status === "lost") {
    ui.resultEyebrow.textContent = "MISSION FAILED";
    ui.resultTitle.textContent = "TARGET SURVIVED";
    ui.continueButton.querySelector("span").textContent = "RETRY";
    ui.continueButton.querySelector("small").textContent = "新しい敵へ";
  }
  ui.runButton.disabled = state.running || game.status !== "playing";
  drawArena();
}

function resizeCanvas() {
  const rect = ui.canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (ui.canvas.width !== width || ui.canvas.height !== height) {
    ui.canvas.width = width;
    ui.canvas.height = height;
  }
  drawArena();
}

function arenaGeometry() {
  const { rows, cols } = state.game;
  const width = ui.canvas.width;
  const height = ui.canvas.height;
  const padX = Math.max(40, width * 0.075);
  const padY = Math.max(48, height * 0.1);
  const cell = Math.min((width - padX * 2) / cols, (height - padY * 2) / rows);
  const gridWidth = cell * cols;
  const gridHeight = cell * rows;
  return {
    width,
    height,
    cell,
    left: (width - gridWidth) / 2,
    top: (height - gridHeight) / 2,
    gridWidth,
    gridHeight,
  };
}

function cellCenter(geometry, row, col) {
  return [
    geometry.left + (col + 0.5) * geometry.cell,
    geometry.top + (row + 0.5) * geometry.cell,
  ];
}

function drawDiamond(context, x, y, radius, fill, stroke) {
  context.beginPath();
  context.moveTo(x, y - radius);
  context.lineTo(x + radius, y);
  context.lineTo(x, y + radius);
  context.lineTo(x - radius, y);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  context.strokeStyle = stroke;
  context.stroke();
}

function drawArena() {
  if (!state.game || !ui.canvas.width) return;
  const context = ui.canvas.getContext("2d");
  const game = state.game;
  const geometry = arenaGeometry();
  context.clearRect(0, 0, geometry.width, geometry.height);

  const background = context.createRadialGradient(
    geometry.width / 2,
    geometry.height / 2,
    0,
    geometry.width / 2,
    geometry.height / 2,
    Math.max(geometry.width, geometry.height) * 0.7,
  );
  background.addColorStop(0, "#17243c");
  background.addColorStop(0.58, "#0a1222");
  background.addColorStop(1, "#050912");
  context.fillStyle = background;
  context.fillRect(0, 0, geometry.width, geometry.height);

  context.save();
  context.translate(geometry.width / 2, geometry.height / 2);
  for (let radius = 50; radius < Math.max(geometry.width, geometry.height); radius += 55) {
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.strokeStyle = "rgba(91,231,255,0.035)";
    context.stroke();
  }
  context.restore();

  const armor = context.createLinearGradient(
    geometry.left,
    geometry.top,
    geometry.left + geometry.gridWidth,
    geometry.top + geometry.gridHeight,
  );
  armor.addColorStop(0, "rgba(40,62,96,0.66)");
  armor.addColorStop(0.5, "rgba(17,31,54,0.85)");
  armor.addColorStop(1, "rgba(37,47,80,0.68)");
  context.fillStyle = armor;
  context.fillRect(geometry.left, geometry.top, geometry.gridWidth, geometry.gridHeight);

  context.lineWidth = Math.max(1, geometry.width / 1000);
  context.strokeStyle = "rgba(132,166,211,0.18)";
  for (let row = 0; row <= game.rows; row += 1) {
    const y = geometry.top + row * geometry.cell;
    context.beginPath();
    context.moveTo(geometry.left, y);
    context.lineTo(geometry.left + geometry.gridWidth, y);
    context.stroke();
  }
  for (let col = 0; col <= game.cols; col += 1) {
    const x = geometry.left + col * geometry.cell;
    context.beginPath();
    context.moveTo(x, geometry.top);
    context.lineTo(x, geometry.top + geometry.gridHeight);
    context.stroke();
  }

  if (state.trail.length > 1) {
    context.beginPath();
    state.trail.forEach(([row, col], index) => {
      const [x, y] = cellCenter(geometry, row, col);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = "rgba(91,231,255,0.58)";
    context.lineWidth = Math.max(2, geometry.cell * 0.1);
    context.lineJoin = "round";
    context.lineCap = "round";
    context.shadowColor = "#5be7ff";
    context.shadowBlur = geometry.cell * 0.32;
    context.stroke();
    context.shadowBlur = 0;
  }

  for (const point of game.weakpoints) {
    const [x, y] = cellCenter(geometry, point.row, point.col);
    const alive = point.hp > 0;
    context.shadowColor = alive ? "#ff5c7f" : "#4d5c75";
    context.shadowBlur = alive ? geometry.cell * 0.6 : 0;
    context.fillStyle = alive ? "rgba(255,92,127,0.92)" : "rgba(65,78,102,0.72)";
    context.beginPath();
    context.arc(x, y, geometry.cell * 0.25, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = alive ? "rgba(255,226,232,0.9)" : "rgba(136,149,172,0.5)";
    context.lineWidth = Math.max(1, geometry.cell * 0.05);
    context.stroke();

    if (geometry.cell > 26) {
      context.fillStyle = alive ? "#fff" : "#8995aa";
      context.font = `700 ${Math.max(8, geometry.cell * 0.22)}px Cascadia Code, monospace`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(point.id), x, y + 0.5);
    }
  }

  const current = state.displayPosition || game.current;
  const [currentX, currentY] = cellCenter(geometry, current[0], current[1]);
  context.lineWidth = Math.max(1.5, geometry.cell * 0.06);
  context.shadowColor = "#5be7ff";
  context.shadowBlur = geometry.cell * 0.55;
  drawDiamond(context, currentX, currentY, geometry.cell * 0.28, "#eefdff", "#5be7ff");
  context.shadowBlur = 0;

  if (state.flash) {
    const [x, y] = cellCenter(geometry, state.flash.row, state.flash.col);
    context.strokeStyle = `rgba(255,255,255,${state.flash.opacity})`;
    context.lineWidth = Math.max(2, geometry.cell * 0.08);
    context.beginPath();
    context.arc(x, y, geometry.cell * (0.32 + (1 - state.flash.opacity) * 0.35), 0, Math.PI * 2);
    context.stroke();
  }

  context.fillStyle = "rgba(145,160,187,0.85)";
  context.font = `${Math.max(11, geometry.width / 68)}px Cascadia Code, monospace`;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillText(`STEP LIMIT ${game.stepLimit}  ·  START ${formatPosition(game.current)}`, geometry.left, Math.max(22, geometry.top - 14));
}

function logBattle(message, kind = "INFO") {
  const timestamp = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  ui.battleConsole.textContent += `[${timestamp}] ${kind.padEnd(5)} ${message}\n`;
  ui.battleConsole.scrollTop = ui.battleConsole.scrollHeight;
}

function setConsole(name) {
  $$(".console-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.console === name));
  $$(".console").forEach((consoleElement) => {
    consoleElement.classList.toggle("active", consoleElement.id.toLowerCase().startsWith(name));
  });
}

function compilerMessage(result) {
  return [
    result.compiler_message,
    result.program_error,
    result.signal ? `Signal: ${result.signal}` : "",
    `Exit: ${result.status ?? "?"}`,
  ].filter(Boolean).join("\n");
}

async function animateAttack(path, damage, attackStats) {
  const token = ++state.animationToken;
  const interval = Math.max(14, Math.min(55, 1900 / path.length));
  let hitCount = 0;
  let damageDealt = 0;
  state.trail = [[...state.game.current]];
  state.displayPosition = [...state.game.current];

  for (let index = 0; index < path.length; index += 1) {
    if (token !== state.animationToken) return;
    const [row, col] = path[index];
    state.trail.push([row, col]);
    state.displayPosition = [row, col];
    const point = state.game.weakpoints.find((candidate) => candidate.row === row && candidate.col === col && candidate.hp > 0);
    if (point) {
      const before = point.hp;
      point.hp = Math.max(0, point.hp - damage);
      hitCount += 1;
      damageDealt += before - point.hp;
      state.flash = { row, col, opacity: 1 };
      logBattle(`HIT WP-${String(point.id).padStart(2, "0")} [${row}, ${col}]  -${Math.min(before, damage)}  ·  HP ${point.hp}/${point.maxHp}`, "HIT");
      renderGame();
    } else {
      if (state.flash) state.flash.opacity *= 0.78;
      if (state.flash?.opacity < 0.08) state.flash = null;
      drawArena();
    }
    await wait(interval);
  }

  state.flash = null;
  const end = path.at(-1);
  recordAttackStats(state.game, {
    ...attackStats,
    steps: path.length,
    hits: hitCount,
    damagePerHit: damage,
    damageDealt,
  });
  finishTurn(state.game, end);
  state.displayPosition = null;
  saveGame();
  renderGame();

  if (state.game.status === "won") {
    const score = calculateClearScore(state.game);
    logBattle(`${state.game.turn}ターンで全弱点を破壊 · SCORE ${score.total.toLocaleString("ja-JP")} · RANK ${score.rank}`, "CLEAR");
  } else if (state.game.status === "lost") {
    logBattle(`ターン上限に到達。残存HP ${totalHp(state.game)}。`, "FAIL");
  } else {
    logBattle(`TURN ${state.game.turn} END · 残存HP ${totalHp(state.game)} · 次回開始 ${formatPosition(state.game.current)} · 歩数上限 ${state.game.stepLimit}`);
  }
}

async function runAttack() {
  if (state.running || state.game.status !== "playing") return;
  const userCode = getCode();
  if (!userCode.trim()) {
    logBattle("コードが空です。", "ERROR");
    return;
  }

  state.running = true;
  state.trail = [];
  state.displayPosition = [...state.game.current];
  ui.runButton.disabled = true;
  ui.runButtonText.textContent = "Wandboxで実行中…";
  ui.compilerConsole.textContent = "コンパイルと実行を開始しました…";
  ui.outputConsole.textContent = "";
  logBattle(`TURN ${state.game.turn + 1} · ${LANGUAGES[state.language].label} · START ${formatPosition(state.game.current)} · LIMIT ${state.game.stepLimit}`);

  try {
    const source = buildSource(state.language, userCode, state.game);
    const request = createWandboxRequest(state.language, source);
    const response = await fetch(WANDBOX_COMPILE_URL, {
      method: "POST",
      mode: "cors",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Wandbox HTTP ${response.status}`);
    const result = await response.json();
    ui.compilerConsole.textContent = compilerMessage(result) || "コンパイル成功 / メッセージなし";
    if (String(result.status) !== "0") {
      setConsole("compiler");
      throw new Error("プログラムが正常終了しませんでした。コンパイラタブを確認してください。");
    }

    const parsed = parseProgramOutput(result.program_output || "");
    const validation = validatePath(
      parsed.path,
      state.game.current,
      state.game.rows,
      state.game.cols,
      state.game.stepLimit,
    );
    ui.outputConsole.textContent = [
      parsed.userOutput || "(ユーザー出力なし)",
      "",
      `[engine] path: ${parsed.path.length} steps`,
      `[engine] time: ${parsed.metrics.timeMs.toFixed(6)} ms`,
      `[engine] memory: ${(parsed.metrics.memoryKb / 1024).toFixed(2)} MB`,
    ].join("\n");
    if (!validation.valid) {
      setConsole("battle");
      throw new Error(validation.reason);
    }

    const codeBytes = utf8Length(userCode);
    const damage = calculateDamage({
      language: state.language,
      codeBytes,
      timeMs: parsed.metrics.timeMs,
      memoryKb: parsed.metrics.memoryKb,
      hp: state.game.hp,
      maxTurns: state.game.maxTurns,
    });
    ui.damagePreview.textContent = damage;
    logBattle(`SCORE ${codeBytes} bytes · ${parsed.metrics.timeMs.toFixed(3)} ms · ${(parsed.metrics.memoryKb / 1024).toFixed(2)} MB · DAMAGE ${damage}/HIT`, "SCORE");
    await animateAttack(parsed.path, damage, {
      language: state.language,
      codeBytes,
      timeMs: parsed.metrics.timeMs,
      memoryKb: parsed.metrics.memoryKb,
    });
    ui.apiStatus.className = "api-status online";
    ui.apiStatus.innerHTML = "<i></i> Wandbox オンライン";
  } catch (error) {
    state.displayPosition = null;
    state.trail = [];
    logBattle(`${error.message}（ターンは消費されません）`, "ERROR");
    drawArena();
  } finally {
    state.running = false;
    ui.runButtonText.textContent = "攻撃を実行";
    renderGame();
  }
}

function newGame() {
  if (state.running) return;
  state.animationToken += 1;
  state.game = createGame();
  state.trail = [];
  state.displayPosition = null;
  state.flash = null;
  ui.battleConsole.textContent = "";
  ui.compilerConsole.textContent = "";
  ui.outputConsole.textContent = "";
  saveGame();
  logBattle(`NEW TARGET · GRID ${state.game.rows}×${state.game.cols} · ${state.game.weakpointCount} WEAK POINTS · HP ${state.game.hp} · ${state.game.maxTurns} TURNS`);
  logBattle(`SCAN COMPLETE · START ${formatPosition(state.game.start)} · STEP LIMIT ${state.game.stepLimit}`);
  renderGame();
  updateCodeStats();
}

function switchLanguage(language) {
  if (language === state.language && getCode().trim()) return;
  saveCode();
  state.language = language;
  localStorage.setItem(`${STORAGE_PREFIX}:language`, language);
  $$(".language-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.language === language));
  ui.compilerLabel.textContent = LANGUAGES[language].label;
  const code = localStorage.getItem(codeStorageKey(language)) || LANGUAGES[language].template;
  if (state.editor) {
    state.editor.setValue(code);
    window.monaco.editor.setModelLanguage(state.editor.getModel(), LANGUAGES[language].editorLanguage);
  } else {
    ui.editorFallback.value = code;
  }
  updateCodeStats();
}

function setupFallbackEditor() {
  ui.editorFallback.value = localStorage.getItem(codeStorageKey()) || LANGUAGES[state.language].template;
  ui.editorFallback.addEventListener("input", updateCodeStats);
  ui.editorFallback.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") runAttack();
    if (event.key === "Tab") {
      event.preventDefault();
      const start = event.target.selectionStart;
      event.target.setRangeText("    ", start, event.target.selectionEnd, "end");
      updateCodeStats();
    }
  });
}

function initializeMonaco() {
  if (!window.require) return;
  window.require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" } });
  window.require(["vs/editor/editor.main"], () => {
    window.monaco.editor.defineTheme("grid-breaker", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "66758F" },
        { token: "keyword", foreground: "8F82FF" },
        { token: "number", foreground: "FFD069" },
        { token: "string", foreground: "61EFB1" },
      ],
      colors: {
        "editor.background": "#0A1020",
        "editor.lineHighlightBackground": "#111A2E",
        "editorGutter.background": "#0A1020",
        "editorCursor.foreground": "#5BE7FF",
      },
    });
    state.editor = window.monaco.editor.create($("#editor"), {
      value: ui.editorFallback.value,
      language: LANGUAGES[state.language].editorLanguage,
      theme: "grid-breaker",
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: "Cascadia Code, JetBrains Mono, Consolas, monospace",
      fontSize: 13,
      lineHeight: 22,
      padding: { top: 16, bottom: 16 },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      smoothScrolling: true,
      tabSize: 4,
    });
    ui.editorFallback.classList.add("hidden");
    state.editor.onDidChangeModelContent(updateCodeStats);
    state.editor.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.Enter, runAttack);
    updateCodeStats();
  });
}

async function checkApi() {
  try {
    const response = await fetch(WANDBOX_LIST_URL, { mode: "cors" });
    if (!response.ok) throw new Error();
    ui.apiStatus.className = "api-status online";
    ui.apiStatus.innerHTML = "<i></i> Wandbox オンライン";
  } catch {
    ui.apiStatus.className = "api-status error";
    ui.apiStatus.innerHTML = "<i></i> Wandbox 接続不可";
  }
}

function bindEvents() {
  $("#newGameButton").addEventListener("click", newGame);
  ui.continueButton.addEventListener("click", newGame);
  ui.runButton.addEventListener("click", runAttack);
  $$(".language-tab").forEach((tab) => tab.addEventListener("click", () => switchLanguage(tab.dataset.language)));
  $$(".console-tab").forEach((tab) => tab.addEventListener("click", () => setConsole(tab.dataset.console)));
  $("#helpButton").addEventListener("click", () => ui.helpDialog.showModal());
  $("#closeHelp").addEventListener("click", () => ui.helpDialog.close());
  ui.helpDialog.addEventListener("click", (event) => {
    if (event.target === ui.helpDialog) ui.helpDialog.close();
  });
  window.addEventListener("resize", resizeCanvas);
  new ResizeObserver(resizeCanvas).observe(ui.canvas.parentElement);
}

state.game = loadGame();
if (!LANGUAGES[state.language]) state.language = "python";
setupFallbackEditor();
bindEvents();
$$(`.language-tab`).forEach((tab) => tab.classList.toggle("active", tab.dataset.language === state.language));
ui.compilerLabel.textContent = LANGUAGES[state.language].label;
initializeMonaco();
renderGame();
resizeCanvas();
updateCodeStats();
checkApi();
logBattle(`TARGET READY · START ${formatPosition(state.game.current)} · ${livingWeakpoints(state.game).length} WEAK POINTS · STEP LIMIT ${state.game.stepLimit}`);

window.__GRID_BREAKER__ = { state, newGame, runAttack };
