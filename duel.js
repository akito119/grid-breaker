import { DUEL_LANGUAGES } from "./duel-runners.js";

const $ = (selector) => document.querySelector(selector);
const PHASE_LABELS = {
  waiting: "WAITING FOR PLAYER",
  walls: "WALL PLACEMENT",
  methods: "METHOD BUILD",
  placement: "TOKEN DEPLOYMENT",
  resolving: "RESOLUTION",
  result: "TURN RESULT",
  finished: "MATCH FINISHED",
};

const ui = {
  lobby: $("#lobby"), game: $("#game"), serverUrl: $("#serverUrl"), playerName: $("#playerName"),
  createForm: $("#createForm"), joinForm: $("#joinForm"), joinRoomId: $("#joinRoomId"),
  lobbyError: $("#lobbyError"), gameError: $("#gameError"), serverStatus: $("#serverStatus"),
  roomId: $("#roomId"), phaseTitle: $("#phaseTitle"), turnText: $("#turnText"), timerText: $("#timerText"),
  shareUrl: $("#shareUrl"), copyShare: $("#copyShare"), canvas: $("#duelArena"), arenaHelp: $("#arenaHelp"),
  meSide: $("#meSide"), meName: $("#meName"), meHp: $("#meHp"), meMp: $("#meMp"), meReady: $("#meReady"),
  enemySide: $("#enemySide"), enemyName: $("#enemyName"), enemyHp: $("#enemyHp"), enemyMp: $("#enemyMp"), enemyReady: $("#enemyReady"),
  eventLog: $("#eventLog"), pollStatus: $("#pollStatus"), wallCount: $("#wallCount"), wallLimit: $("#wallLimit"), submitWalls: $("#submitWalls"),
  methodName: $("#methodName"), methodType: $("#methodType"), methodLanguage: $("#methodLanguage"), methodEffect: $("#methodEffect"), methodCode: $("#methodCode"),
  saveMethod: $("#saveMethod"), newMethod: $("#newMethod"), methodList: $("#methodList"), submitMethods: $("#submitMethods"),
  placementHp: $("#placementHp"), tokenRows: $("#tokenRows"), addToken: $("#addToken"), submitPlacement: $("#submitPlacement"),
  resultTitle: $("#resultTitle"), resultText: $("#resultText"), nextTurn: $("#nextTurn"),
};

const panels = {
  waiting: $("#waitingPanel"), walls: $("#wallsPanel"), methods: $("#methodsPanel"),
  placement: $("#placementPanel"), resolving: $("#resolvingPanel"), result: $("#resultPanel"), finished: $("#resultPanel"),
};

const state = {
  credentials: null,
  snapshot: null,
  phase: null,
  draftWalls: [],
  methods: [],
  editingMethodId: null,
  tokenDrafts: [],
  polling: false,
  syncing: false,
};

function normalizeServerUrl(value) {
  return String(value || location.origin).trim().replace(/\/+$/, "");
}

function queryDefaults() {
  const params = new URLSearchParams(location.search);
  ui.serverUrl.value = params.get("server") || localStorage.getItem("grid-breaker:duel:server") || location.origin;
  ui.joinRoomId.value = (params.get("room") || "").toUpperCase();
  ui.playerName.value = localStorage.getItem("grid-breaker:duel:name") || "PLAYER";
}

async function api(path, { method = "GET", body = null, auth = true } = {}) {
  const server = normalizeServerUrl(ui.serverUrl.value);
  localStorage.setItem("grid-breaker:duel:server", server);
  let url = `${server}${path}`;
  const options = { method, headers: {} };
  if (method === "GET" && auth && state.credentials) {
    const separator = url.includes("?") ? "&" : "?";
    url += `${separator}playerId=${encodeURIComponent(state.credentials.playerId)}&secret=${encodeURIComponent(state.credentials.secret)}`;
  }
  if (method !== "GET") {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(auth && state.credentials ? { ...body, playerId: state.credentials.playerId, secret: state.credentials.secret } : body);
  }
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function saveSession() {
  if (!state.credentials) return;
  sessionStorage.setItem("grid-breaker:duel:session", JSON.stringify({ ...state.credentials, server: normalizeServerUrl(ui.serverUrl.value) }));
}

function loadSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem("grid-breaker:duel:session"));
    if (saved?.roomId && saved?.playerId && saved?.secret) {
      state.credentials = saved;
      if (saved.server) ui.serverUrl.value = saved.server;
      return true;
    }
  } catch {}
  return false;
}

function setCredentials(data) {
  state.credentials = { roomId: data.roomId, playerId: data.playerId, secret: data.secret, side: data.side };
  saveSession();
  ui.lobby.classList.add("hidden");
  ui.game.classList.remove("hidden");
  pollState();
}

async function checkServer() {
  try {
    await api("/api/health", { auth: false });
    ui.serverStatus.textContent = "ROOM SERVER ONLINE";
    ui.serverStatus.className = "status-dot online";
  } catch {
    ui.serverStatus.textContent = "ROOM SERVER OFFLINE";
    ui.serverStatus.className = "status-dot error";
  }
}

function settingsFromForm(form) {
  const data = new FormData(form);
  return Object.fromEntries([...data.entries()].map(([key, value]) => [key, Number(value)]));
}

function createShareUrl(snapshot) {
  const url = new URL("/", `${normalizeServerUrl(ui.serverUrl.value)}/`);
  url.search = "";
  url.hash = "";
  url.searchParams.set("server", normalizeServerUrl(ui.serverUrl.value));
  url.searchParams.set("room", snapshot.roomId);
  return url.toString();
}

function formatTimer(deadline, serverTime) {
  if (!deadline) return "--:--";
  const remaining = Math.max(0, Math.ceil((deadline - serverTime) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function resetMethodEditor(language = "python") {
  state.editingMethodId = null;
  ui.methodName.value = `METHOD-${String(state.methods.length + 1).padStart(2, "0")}`;
  ui.methodType.value = "coordinate";
  ui.methodLanguage.value = language;
  ui.methodEffect.value = "10";
  ui.methodCode.value = DUEL_LANGUAGES[language].template;
}

function methodFromEditor(existingId = null) {
  return {
    id: existingId || crypto.randomUUID(),
    name: ui.methodName.value.trim() || "METHOD",
    type: ui.methodType.value,
    language: ui.methodLanguage.value,
    effect: Math.max(1, Math.trunc(Number(ui.methodEffect.value) || 1)),
    code: ui.methodCode.value,
  };
}

function saveCurrentMethod() {
  if (!ui.methodCode.value.trim()) return;
  const method = methodFromEditor(state.editingMethodId);
  const index = state.methods.findIndex((item) => item.id === method.id);
  if (index >= 0) state.methods[index] = method;
  else state.methods.push(method);
  state.editingMethodId = method.id;
  renderMethodList();
}

function methodsForSubmit() {
  const methods = state.methods.map((method) => ({ ...method }));
  if (ui.methodCode.value.trim()) {
    const current = methodFromEditor(state.editingMethodId);
    const index = methods.findIndex((method) => method.id === current.id);
    if (index >= 0) methods[index] = current;
    else methods.push(current);
  }
  return methods.slice(0, state.snapshot?.settings.tokenLimit || 12);
}

function editMethod(id) {
  const method = state.methods.find((item) => item.id === id);
  if (!method) return;
  state.editingMethodId = id;
  ui.methodName.value = method.name;
  ui.methodType.value = method.type;
  ui.methodLanguage.value = method.language;
  ui.methodEffect.value = method.effect;
  ui.methodCode.value = method.code;
}

function renderMethodList() {
  ui.methodList.replaceChildren();
  for (const method of state.methods) {
    const row = document.createElement("div");
    row.className = "method-item";
    const label = document.createElement("span");
    label.textContent = method.name;
    const meta = document.createElement("small");
    meta.textContent = `${method.type} / ${method.language} / ${method.effect}`;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "編集";
    edit.addEventListener("click", () => editMethod(method.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "削除";
    remove.addEventListener("click", () => {
      state.methods = state.methods.filter((item) => item.id !== method.id);
      if (state.editingMethodId === method.id) resetMethodEditor();
      renderMethodList();
    });
    row.append(label, meta, edit, remove);
    ui.methodList.append(row);
  }
}

function defaultTokenDraft(snapshot) {
  return [{ id: crypto.randomUUID(), row: Math.floor(snapshot.settings.gridSize / 2), col: 0, hp: snapshot.me.hp, methodId: state.methods[0]?.id || "", order: 1 }];
}

function renderTokenRows() {
  ui.tokenRows.replaceChildren();
  state.tokenDrafts.forEach((token, index) => {
    const row = document.createElement("div");
    row.className = "token-row";
    const name = document.createElement("span");
    name.textContent = `T${index + 1}`;
    const fields = [
      ["ROW", "row", "number"], ["COL", "col", "number"], ["HP", "hp", "number"], ["ORDER", "order", "number"],
    ];
    for (const [labelText, key, type] of fields) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.type = type;
      input.min = key === "col" || key === "row" ? "0" : "1";
      input.value = token[key];
      input.addEventListener("input", () => { token[key] = Number(input.value); updatePlacementHp(); drawArena(); });
      label.append(input);
      row.append(label);
    }
    const methodLabel = document.createElement("label");
    methodLabel.textContent = "METHOD";
    const select = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "なし";
    select.append(none);
    for (const method of state.methods) {
      const option = document.createElement("option");
      option.value = method.id;
      option.textContent = method.name;
      select.append(option);
    }
    select.value = token.methodId || "";
    select.addEventListener("change", () => { token.methodId = select.value; });
    methodLabel.append(select);
    row.append(methodLabel);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-token";
    remove.textContent = "×";
    remove.disabled = state.tokenDrafts.length <= 1;
    remove.addEventListener("click", () => { state.tokenDrafts.splice(index, 1); renderTokenRows(); updatePlacementHp(); drawArena(); });
    row.prepend(name);
    row.append(remove);
    ui.tokenRows.append(row);
  });
  updatePlacementHp();
}

function updatePlacementHp() {
  const total = state.tokenDrafts.reduce((sum, token) => sum + (Number(token.hp) || 0), 0);
  const target = state.snapshot?.me.hp || 0;
  ui.placementHp.textContent = `${total} / ${target}`;
  ui.placementHp.style.color = total === target ? "var(--green)" : "var(--red)";
}

function phaseChanged(snapshot) {
  if (state.phase === snapshot.phase) return;
  state.phase = snapshot.phase;
  if (snapshot.phase === "walls") state.draftWalls = snapshot.me.wallCandidates || [];
  if (snapshot.phase === "methods") {
    state.methods = snapshot.me.methods?.length ? snapshot.me.methods.map((method) => ({ ...method })) : [];
    resetMethodEditor();
    renderMethodList();
  }
  if (snapshot.phase === "placement") {
    state.methods = snapshot.me.methods.map((method) => ({ ...method }));
    state.tokenDrafts = snapshot.me.tokens?.length ? snapshot.me.tokens.map((token) => ({ ...token })) : defaultTokenDraft(snapshot);
    renderTokenRows();
  }
}

function renderEvents(snapshot) {
  const lines = [];
  for (const event of snapshot.events || []) {
    if (event.type === "walls") lines.push(`[WALL] ${event.walls.length} walls accepted`);
    else if (event.type === "resolution-start") lines.push(`[TURN ${event.turn}] RESOLUTION START`);
    else if (event.type === "method") {
      const collision = event.collision ? ` / ${event.status.toUpperCase()} @ ${event.collision.join(",")}` : "";
      lines.push(`[${event.side}] ${event.methodName} / ${event.language} / ${event.timeMs?.toFixed?.(3) || "-"}ms / MP ${event.mpCost}${collision}`);
      for (const hit of event.hits || []) {
        if (hit.kind === "attack") lines.push(`  HIT ${hit.cell.join(",")} damage=${hit.damage} shield=${hit.blocked}`);
        else lines.push(`  SHIELD ${hit.cell.join(",")} +${hit.amount}`);
      }
    } else if (event.type === "method-error") lines.push(`[${event.side}] ERROR ${event.status}: ${event.message}`);
    else if (event.type === "skip") lines.push(`[${event.side}] SKIP ${event.reason}`);
    else if (event.type === "resolution-end") lines.push(`[RESULT] A ${event.hpA} HP / B ${event.hpB} HP${event.winner ? ` / WINNER ${event.winner}` : ""}`);
    else if (event.type === "server-error") lines.push(`[SERVER ERROR] ${event.message}`);
  }
  ui.eventLog.textContent = lines.join("\n") || "No events yet.";
  ui.eventLog.scrollTop = ui.eventLog.scrollHeight;
}

function render(snapshot) {
  state.snapshot = snapshot;
  phaseChanged(snapshot);
  ui.roomId.textContent = snapshot.roomId;
  ui.phaseTitle.textContent = PHASE_LABELS[snapshot.phase] || snapshot.phase.toUpperCase();
  ui.turnText.textContent = snapshot.suddenDeath ? `TURN ${snapshot.turn} / SUDDEN DEATH` : `TURN ${snapshot.turn} / ${snapshot.settings.maxTurns}`;
  ui.timerText.textContent = formatTimer(snapshot.phaseDeadline, snapshot.serverTime);
  ui.shareUrl.value = createShareUrl(snapshot);
  ui.meSide.textContent = snapshot.me.side;
  ui.meName.textContent = snapshot.me.name;
  ui.meHp.textContent = snapshot.me.hp;
  ui.meMp.textContent = snapshot.me.mp;
  ui.meReady.textContent = snapshot.me.ready ? "READY" : "EDITING";
  ui.enemySide.textContent = snapshot.opponent?.side || "-";
  ui.enemyName.textContent = snapshot.opponent?.name || "WAITING";
  ui.enemyHp.textContent = snapshot.opponent?.hp ?? "--";
  ui.enemyMp.textContent = snapshot.opponent?.mp ?? "--";
  ui.enemyReady.textContent = snapshot.opponent ? (snapshot.opponent.ready ? "READY" : "EDITING") : "OFFLINE";
  Object.values(panels).forEach((panel) => panel.classList.add("hidden"));
  panels[snapshot.phase]?.classList.remove("hidden");
  ui.wallLimit.textContent = snapshot.settings.wallLimit;
  ui.wallCount.textContent = state.draftWalls.length;
  ui.submitWalls.disabled = snapshot.me.ready;
  ui.submitMethods.disabled = snapshot.me.ready;
  ui.submitPlacement.disabled = snapshot.me.ready;
  ui.nextTurn.disabled = snapshot.me.nextReady;
  ui.arenaHelp.textContent = snapshot.phase === "walls"
    ? "クリックで壁候補を追加・削除。青い壁があなたの候補、白い壁が確定壁です。"
    : "壁とトークンは、あなたから見た正規化座標で表示されています。";
  if (snapshot.phase === "finished") {
    ui.resultTitle.textContent = snapshot.winner === snapshot.me.side ? "YOU WIN" : "YOU LOSE";
    ui.resultText.textContent = `勝者: PLAYER ${snapshot.winner}`;
    ui.nextTurn.classList.add("hidden");
  } else if (snapshot.phase === "result") {
    ui.resultTitle.textContent = snapshot.suddenDeath ? "SUDDEN DEATH" : `TURN ${snapshot.turn} END`;
    ui.resultText.textContent = `HP ${snapshot.me.hp} - ${snapshot.opponent?.hp ?? "--"}。両者が準備完了すると次の壁配置へ進みます。`;
    ui.nextTurn.classList.remove("hidden");
  }
  renderEvents(snapshot);
  drawArena();
}

function canvasGeometry() {
  const canvas = ui.canvas;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const size = state.snapshot?.settings.gridSize || 10;
  const padding = Math.max(28 * ratio, Math.min(width, height) * .055);
  const cell = Math.min((width - padding * 2) / size, (height - padding * 2) / size);
  return { width, height, size, cell, left: (width - cell * size) / 2, top: (height - cell * size) / 2 };
}

function drawToken(context, geometry, token, color, label) {
  const x = geometry.left + (token.col + .5) * geometry.cell;
  const y = geometry.top + (token.row + .5) * geometry.cell;
  context.beginPath();
  context.arc(x, y, geometry.cell * .28, 0, Math.PI * 2);
  context.fillStyle = color;
  context.shadowColor = color;
  context.shadowBlur = geometry.cell * .35;
  context.fill();
  context.shadowBlur = 0;
  context.fillStyle = "#fff";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `700 ${Math.max(8, geometry.cell * .2)}px monospace`;
  context.fillText(`${label}:${token.hp}`, x, y);
}

function drawArena() {
  const geometry = canvasGeometry();
  const context = ui.canvas.getContext("2d");
  context.clearRect(0, 0, geometry.width, geometry.height);
  context.fillStyle = "#050a13";
  context.fillRect(0, 0, geometry.width, geometry.height);
  const half = Math.floor(geometry.size / 2);
  context.fillStyle = "rgba(85,230,255,.045)";
  context.fillRect(geometry.left, geometry.top, half * geometry.cell, geometry.size * geometry.cell);
  context.fillStyle = "rgba(255,93,125,.035)";
  context.fillRect(geometry.left + (geometry.size - half) * geometry.cell, geometry.top, half * geometry.cell, geometry.size * geometry.cell);
  context.strokeStyle = "rgba(133,164,207,.19)";
  context.lineWidth = 1;
  for (let index = 0; index <= geometry.size; index += 1) {
    const x = geometry.left + index * geometry.cell;
    const y = geometry.top + index * geometry.cell;
    context.beginPath(); context.moveTo(x, geometry.top); context.lineTo(x, geometry.top + geometry.size * geometry.cell); context.stroke();
    context.beginPath(); context.moveTo(geometry.left, y); context.lineTo(geometry.left + geometry.size * geometry.cell, y); context.stroke();
  }
  const drawWall = ([row, col], fill) => {
    if (row < 0 || row >= geometry.size || col < 0 || col >= geometry.size) return;
    const inset = Math.max(2, geometry.cell * .1);
    context.fillStyle = fill;
    context.fillRect(geometry.left + col * geometry.cell + inset, geometry.top + row * geometry.cell + inset, geometry.cell - inset * 2, geometry.cell - inset * 2);
  };
  for (const wall of state.snapshot?.walls || []) drawWall(wall, "rgba(225,235,250,.72)");
  if (state.snapshot?.phase === "walls") for (const wall of state.draftWalls) drawWall(wall, "rgba(85,230,255,.78)");
  const lastMethod = [...(state.snapshot?.events || [])].reverse().find((event) => event.type === "method");
  if (lastMethod?.path?.length) {
    context.beginPath();
    const own = lastMethod.side === state.snapshot.me.side;
    const color = own ? "#55e6ff" : "#ff5d7d";
    const startToken = (own ? state.snapshot.me.tokens : state.snapshot.opponent?.tokens || []).find((token) => token.id === lastMethod.tokenId);
    const points = startToken ? [[startToken.row, startToken.col], ...lastMethod.path] : lastMethod.path;
    points.forEach(([row, col], index) => {
      const x = geometry.left + (col + .5) * geometry.cell;
      const y = geometry.top + (row + .5) * geometry.cell;
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.strokeStyle = color;
    context.lineWidth = Math.max(2, geometry.cell * .1);
    context.stroke();
  }
  const ownTokens = state.snapshot?.phase === "placement" ? state.tokenDrafts : state.snapshot?.me.tokens || [];
  for (const token of ownTokens) drawToken(context, geometry, token, "#30bfdc", "Y");
  for (const token of state.snapshot?.opponent?.tokens || []) drawToken(context, geometry, token, "#df4968", "E");
}

function canvasCell(event) {
  const rect = ui.canvas.getBoundingClientRect();
  const geometry = canvasGeometry();
  const scaleX = geometry.width / rect.width;
  const scaleY = geometry.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  const col = Math.floor((x - geometry.left) / geometry.cell);
  const row = Math.floor((y - geometry.top) / geometry.cell);
  if (row < 0 || row >= geometry.size || col < 0 || col >= geometry.size) return null;
  return [row, col];
}

async function saveWalls(ready) {
  const snapshot = await api(`/api/rooms/${state.credentials.roomId}/walls`, { method: "POST", body: { walls: state.draftWalls, ready } });
  render(snapshot);
}

async function saveMethods(ready) {
  const methods = methodsForSubmit();
  state.methods = methods;
  renderMethodList();
  const snapshot = await api(`/api/rooms/${state.credentials.roomId}/methods`, { method: "POST", body: { methods, ready } });
  render(snapshot);
}

async function savePlacement(ready) {
  const snapshot = await api(`/api/rooms/${state.credentials.roomId}/placement`, { method: "POST", body: { tokens: state.tokenDrafts, ready } });
  render(snapshot);
}

async function pollState() {
  if (!state.credentials || state.polling) return;
  state.polling = true;
  try {
    const snapshot = await api(`/api/rooms/${state.credentials.roomId}/state`);
    ui.pollStatus.textContent = "SYNCED";
    ui.pollStatus.style.color = "var(--green)";
    ui.gameError.textContent = "";
    render(snapshot);
  } catch (error) {
    ui.pollStatus.textContent = "RETRYING";
    ui.pollStatus.style.color = "var(--red)";
    ui.gameError.textContent = error.message;
  } finally {
    state.polling = false;
  }
}

ui.createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  ui.lobbyError.textContent = "";
  try {
    const result = await api("/api/rooms", { method: "POST", auth: false, body: { name: ui.playerName.value, settings: settingsFromForm(ui.createForm) } });
    localStorage.setItem("grid-breaker:duel:name", ui.playerName.value);
    setCredentials(result);
  } catch (error) { ui.lobbyError.textContent = error.message; }
});

ui.joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  ui.lobbyError.textContent = "";
  try {
    const roomId = ui.joinRoomId.value.trim().toUpperCase();
    const result = await api(`/api/rooms/${roomId}/join`, { method: "POST", auth: false, body: { name: ui.playerName.value } });
    localStorage.setItem("grid-breaker:duel:name", ui.playerName.value);
    setCredentials(result);
  } catch (error) { ui.lobbyError.textContent = error.message; }
});

ui.copyShare.addEventListener("click", async () => {
  await navigator.clipboard.writeText(ui.shareUrl.value);
  ui.copyShare.textContent = "コピー済み";
  setTimeout(() => { ui.copyShare.textContent = "URLをコピー"; }, 1200);
});

ui.canvas.addEventListener("click", async (event) => {
  if (state.snapshot?.phase !== "walls" || state.snapshot.me.ready) return;
  const cell = canvasCell(event);
  if (!cell) return;
  const index = state.draftWalls.findIndex(([row, col]) => row === cell[0] && col === cell[1]);
  if (index >= 0) state.draftWalls.splice(index, 1);
  else if (state.draftWalls.length < state.snapshot.settings.wallLimit) state.draftWalls.push(cell);
  ui.wallCount.textContent = state.draftWalls.length;
  drawArena();
  try { await saveWalls(false); } catch (error) { ui.gameError.textContent = error.message; }
});

ui.submitWalls.addEventListener("click", async () => {
  try { await saveWalls(true); } catch (error) { ui.gameError.textContent = error.message; }
});
ui.methodLanguage.addEventListener("change", () => {
  if (!state.editingMethodId || !ui.methodCode.value.trim()) ui.methodCode.value = DUEL_LANGUAGES[ui.methodLanguage.value].template;
});
ui.saveMethod.addEventListener("click", () => { saveCurrentMethod(); syncDraft(); });
ui.newMethod.addEventListener("click", () => resetMethodEditor(ui.methodLanguage.value));
ui.submitMethods.addEventListener("click", async () => {
  try { await saveMethods(true); } catch (error) { ui.gameError.textContent = error.message; }
});
ui.addToken.addEventListener("click", () => {
  if (state.tokenDrafts.length >= state.snapshot.settings.tokenLimit) return;
  state.tokenDrafts.push({ id: crypto.randomUUID(), row: 0, col: 0, hp: 1, methodId: state.methods[0]?.id || "", order: state.tokenDrafts.length + 1 });
  renderTokenRows(); drawArena();
});
ui.submitPlacement.addEventListener("click", async () => {
  try { await savePlacement(true); } catch (error) { ui.gameError.textContent = error.message; }
});
ui.nextTurn.addEventListener("click", async () => {
  try {
    const snapshot = await api(`/api/rooms/${state.credentials.roomId}/next`, { method: "POST", body: {} });
    render(snapshot);
  } catch (error) { ui.gameError.textContent = error.message; }
});

async function syncDraft() {
  if (!state.snapshot || state.snapshot.me.ready || state.syncing) return;
  state.syncing = true;
  try {
    if (state.snapshot.phase === "methods") await saveMethods(false);
    else if (state.snapshot.phase === "placement") await savePlacement(false);
  } catch {} finally { state.syncing = false; }
}

window.addEventListener("resize", drawArena);
setInterval(pollState, 1000);
setInterval(syncDraft, 4000);
setInterval(() => {
  if (state.snapshot) ui.timerText.textContent = formatTimer(state.snapshot.phaseDeadline, Date.now());
}, 250);

queryDefaults();
resetMethodEditor();
checkServer();
if (loadSession()) {
  ui.lobby.classList.add("hidden");
  ui.game.classList.remove("hidden");
  pollState();
}
