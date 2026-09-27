import { randomUUID } from "node:crypto";
import {
  analyzeTraversal,
  calculateMpCost,
  cellKey,
  fallbackPlacement,
  normalizedRuntime,
  resolveWallCandidates,
  sanitizeRoomSettings,
  sumTokenHp,
  transformCell,
  transformCells,
  validatePlacement,
} from "./duel-core.js";
import {
  DUEL_LANGUAGES,
  buildDuelSource,
  createDuelWandboxRequest,
  parseDuelOutput,
} from "./duel-runners.js";

const WANDBOX_URL = "https://wandbox.org/api/compile.json";
const rooms = new Map();
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_BODY_BYTES = 1_000_000;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error("リクエストが大きすぎます。");
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("JSONを解析できませんでした。");
  }
}

function roomCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return randomUUID().slice(0, 6).toUpperCase();
}

function playerRecord(side, name, settings) {
  return {
    id: randomUUID(),
    secret: randomUUID(),
    side,
    name: String(name || `PLAYER ${side}`).trim().slice(0, 24) || `PLAYER ${side}`,
    hp: settings.maxHp,
    mp: settings.maxMp,
    ready: false,
    nextReady: false,
    wallCandidates: [],
    methods: [],
    tokens: [],
  };
}

function createRoom(name, settingsInput) {
  const settings = sanitizeRoomSettings(settingsInput);
  const code = roomCode();
  const creator = playerRecord("A", name, settings);
  const room = {
    id: code,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings,
    players: [creator],
    phase: "waiting",
    phaseDeadline: null,
    turn: 0,
    suddenDeath: false,
    winner: null,
    walls: [],
    wallDecisions: [],
    events: [],
    known: { A: new Map(), B: new Map() },
    resolvingPromise: null,
  };
  rooms.set(code, room);
  return { room, player: creator };
}

function getRoom(id) {
  const room = rooms.get(String(id || "").toUpperCase());
  if (!room) throw new Error("ルームが見つかりません。");
  return room;
}

function authenticate(room, playerId, secret) {
  const player = room.players.find((candidate) => candidate.id === playerId && candidate.secret === secret);
  if (!player) throw new Error("プレイヤー認証に失敗しました。");
  return player;
}

function otherPlayer(room, side) {
  return room.players.find((player) => player.side !== side);
}

function phaseSeconds(room, phase) {
  if (phase === "walls") return room.settings.wallPlacementSeconds;
  if (phase === "methods") return room.settings.methodBuildSeconds;
  if (phase === "placement") return room.settings.tokenPlacementSeconds;
  return null;
}

function setPhase(room, phase) {
  room.phase = phase;
  room.updatedAt = Date.now();
  const seconds = phaseSeconds(room, phase);
  room.phaseDeadline = seconds ? Date.now() + seconds * 1000 : null;
  for (const player of room.players) player.ready = false;
}

function beginTurn(room) {
  room.turn += 1;
  room.walls = [];
  room.wallDecisions = [];
  room.events = [];
  room.known = { A: new Map(), B: new Map() };
  for (const player of room.players) {
    player.mp = room.settings.maxMp + room.settings.maxHp - player.hp;
    player.wallCandidates = [];
    player.tokens = [];
    player.nextReady = false;
    player.ready = false;
  }
  setPhase(room, "walls");
}

function finalizeWalls(room) {
  const playerA = room.players.find((player) => player.side === "A");
  const playerB = room.players.find((player) => player.side === "B");
  const result = resolveWallCandidates({
    size: room.settings.gridSize,
    wallLimit: room.settings.wallLimit,
    turn: room.turn,
    candidatesA: playerA?.wallCandidates || [],
    candidatesB: playerB?.wallCandidates || [],
  });
  room.walls = result.walls;
  room.wallDecisions = result.decisions;
  room.events.push({ type: "walls", walls: result.walls, decisions: result.decisions });
  setPhase(room, "methods");
}

function sanitizeMethods(room, values) {
  const result = [];
  const ids = new Set();
  for (const raw of Array.isArray(values) ? values.slice(0, room.settings.tokenLimit) : []) {
    const id = String(raw?.id || randomUUID()).slice(0, 80);
    if (ids.has(id)) continue;
    const type = ["coordinate", "homing", "defense"].includes(raw?.type) ? raw.type : "coordinate";
    const language = DUEL_LANGUAGES[raw?.language] ? raw.language : "python";
    const effect = Math.max(1, Math.min(room.settings.maxHp * 4, Math.trunc(Number(raw?.effect) || 1)));
    const code = String(raw?.code || "").slice(0, 60_000);
    if (!code.trim()) continue;
    ids.add(id);
    result.push({ id, name: String(raw?.name || `METHOD ${result.length + 1}`).slice(0, 40), type, language, effect, code });
  }
  return result;
}

function finalizeMethods(room) {
  setPhase(room, "placement");
}

function ensurePlacement(room, player) {
  if (player.tokens.length) return;
  player.tokens = fallbackPlacement({
    size: room.settings.gridSize,
    side: player.side,
    walls: room.walls,
    hp: player.hp,
  });
}

function serializeWallDecision(room, decision, viewerSide) {
  return { ...decision, cell: transformCell(room.settings.gridSize, decision.cell, viewerSide) };
}

function serializeToken(room, token, viewerSide) {
  const [row, col] = transformCell(room.settings.gridSize, [token.row, token.col], viewerSide);
  return { id: token.id, row, col, hp: token.hp, shield: token.shield || 0, methodId: token.methodId, order: token.order, activated: Boolean(token.activated) };
}

function serializeEvent(room, event, viewerSide) {
  const copy = { ...event };
  if (Array.isArray(copy.path)) copy.path = transformCells(room.settings.gridSize, copy.path, viewerSide);
  if (Array.isArray(copy.effectCells)) copy.effectCells = transformCells(room.settings.gridSize, copy.effectCells, viewerSide);
  if (Array.isArray(copy.walls)) copy.walls = transformCells(room.settings.gridSize, copy.walls, viewerSide);
  if (copy.collision) copy.collision = transformCell(room.settings.gridSize, copy.collision, viewerSide);
  if (copy.cell) copy.cell = transformCell(room.settings.gridSize, copy.cell, viewerSide);
  if (Array.isArray(copy.hits)) copy.hits = copy.hits.map((hit) => ({ ...hit, cell: transformCell(room.settings.gridSize, hit.cell, viewerSide) }));
  if (Array.isArray(copy.decisions)) copy.decisions = copy.decisions.map((decision) => serializeWallDecision(room, decision, viewerSide));
  return copy;
}

function stateFor(room, player) {
  const opponent = otherPlayer(room, player.side);
  const showOpponentTokens = ["result", "finished"].includes(room.phase);
  return {
    roomId: room.id,
    settings: room.settings,
    phase: room.phase,
    phaseDeadline: room.phaseDeadline,
    serverTime: Date.now(),
    turn: room.turn,
    suddenDeath: room.suddenDeath,
    winner: room.winner,
    me: {
      id: player.id,
      side: player.side,
      name: player.name,
      hp: player.hp,
      mp: player.mp,
      ready: player.ready,
      nextReady: player.nextReady,
      wallCandidates: player.wallCandidates,
      methods: player.methods,
      tokens: player.tokens.map((token) => serializeToken(room, token, player.side)),
    },
    opponent: opponent ? {
      side: opponent.side,
      name: opponent.name,
      hp: opponent.hp,
      mp: opponent.mp,
      ready: opponent.ready,
      nextReady: opponent.nextReady,
      tokens: showOpponentTokens ? opponent.tokens.map((token) => serializeToken(room, token, player.side)) : [],
    } : null,
    walls: transformCells(room.settings.gridSize, room.walls, player.side),
    wallDecisions: room.wallDecisions.map((decision) => serializeWallDecision(room, decision, player.side)),
    events: room.events.map((event) => serializeEvent(room, event, player.side)),
  };
}

async function executeWandboxMethod(room, player, token, method, knownEnemies) {
  const size = room.settings.gridSize;
  const walls = transformCells(size, room.walls, player.side);
  const start = transformCell(size, [token.row, token.col], player.side);
  const known = [...knownEnemies.values()].map((item) => {
    const [row, col] = transformCell(size, [item.row, item.col], player.side);
    return { row, col, activated: item.activated };
  });
  const maxOutputs = Math.min(4000, size * size * 4);
  const nonce = randomUUID().replaceAll("-", "");
  const source = buildDuelSource(method.language, method.code, { size, walls, start, knownEnemies: known, maxOutputs }, nonce);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(WANDBOX_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createDuelWandboxRequest(method.language, source)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Wandbox HTTP ${response.status}`);
    const result = await response.json();
    if (String(result.status) !== "0") {
      return { ok: false, status: "runtime-error", message: String(result.compiler_error || result.compiler_message || result.program_error || "実行エラー").slice(0, 4000) };
    }
    const parsed = parseDuelOutput(result.program_output || "", nonce);
    const traversal = analyzeTraversal({ size, walls, start, path: parsed.path, maxOutputs });
    if (!traversal.valid || ["invalid", "limit"].includes(parsed.status)) {
      return { ok: false, status: parsed.status || traversal.status, message: traversal.reason || "不正な出力です。", path: parsed.path };
    }
    return {
      ok: true,
      status: parsed.status,
      path: parsed.path,
      traversal,
      timeMs: parsed.timeMs,
      memoryKb: parsed.memoryKb,
      output: parsed.userOutput.slice(0, 4000),
      normalizedTime: normalizedRuntime(method.language, parsed.timeMs),
    };
  } catch (error) {
    return { ok: false, status: error.name === "AbortError" ? "timeout" : "runner-error", message: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function livingTokenAt(tokens, row, col) {
  return tokens.find((token) => token.hp > 0 && token.row === row && token.col === col);
}

function recomputeHp(player) {
  player.hp = sumTokenHp(player.tokens);
}

function applyExecution(room, player, token, method, execution) {
  const event = {
    type: "method",
    side: player.side,
    tokenId: token.id,
    methodId: method.id,
    methodName: method.name,
    methodType: method.type,
    language: method.language,
    status: execution.status,
    timeMs: execution.timeMs,
    memoryKb: execution.memoryKb,
    path: transformCells(room.settings.gridSize, execution.path, player.side),
    effectCells: transformCells(room.settings.gridSize, execution.traversal.effectCells, player.side),
    collision: execution.traversal.collision ? transformCell(room.settings.gridSize, execution.traversal.collision, player.side) : null,
    hits: [],
  };
  const cost = calculateMpCost({ language: method.language, effect: method.effect, memoryKb: execution.memoryKb, outputCount: execution.traversal.attempts.length });
  event.mpCost = cost;
  if (player.mp < cost) {
    event.status = "mp-shortage";
    event.message = `MP不足: 必要 ${cost} / 残り ${player.mp}`;
    room.events.push(event);
    return;
  }
  player.mp -= cost;
  const opponent = otherPlayer(room, player.side);
  let totalDamage = 0;

  for (const [localRow, localCol] of execution.traversal.effectCells) {
    const [row, col] = transformCell(room.settings.gridSize, [localRow, localCol], player.side);
    if (method.type === "defense") {
      if (room.suddenDeath) continue;
      const friendly = livingTokenAt(player.tokens, row, col);
      if (!friendly) continue;
      friendly.shield += method.effect;
      event.hits.push({ kind: "shield", cell: [row, col], amount: method.effect, tokenId: friendly.id });
      continue;
    }
    const target = livingTokenAt(opponent.tokens, row, col);
    if (!target) continue;
    room.known[player.side].set(cellKey(row, col), { row, col, activated: Boolean(target.activated) });
    const blocked = Math.min(target.shield || 0, method.effect);
    target.shield = Math.max(0, (target.shield || 0) - blocked);
    const damage = Math.min(target.hp, method.effect - blocked);
    target.hp -= damage;
    totalDamage += damage;
    event.hits.push({ kind: "attack", cell: [row, col], damage, blocked, tokenId: target.id });
    recomputeHp(opponent);
    if (room.suddenDeath && damage > 0 && !room.winner) room.winner = player.side;
    if (opponent.hp <= 0 && !room.winner) room.winner = player.side;
    if (room.winner) break;
  }
  event.damage = totalDamage;
  event.mpRemaining = player.mp;
  room.events.push(event);
}

function methodFor(player, token) {
  return player.methods.find((method) => method.id === token.methodId) || null;
}

async function resolveRoom(room) {
  room.phase = "resolving";
  room.phaseDeadline = null;
  room.events.push({ type: "resolution-start", turn: room.turn, suddenDeath: room.suddenDeath });
  const playerA = room.players.find((player) => player.side === "A");
  const playerB = room.players.find((player) => player.side === "B");
  const orders = [...new Set([...playerA.tokens, ...playerB.tokens].map((token) => token.order))].sort((a, b) => a - b);

  for (const order of orders) {
    if (room.winner) break;
    const tokenA = playerA.tokens.find((token) => token.order === order && token.hp > 0);
    const tokenB = playerB.tokens.find((token) => token.order === order && token.hp > 0);
    const methodA = tokenA ? methodFor(playerA, tokenA) : null;
    const methodB = tokenB ? methodFor(playerB, tokenB) : null;
    const [executionA, executionB] = await Promise.all([
      methodA && !(room.suddenDeath && methodA.type === "defense") ? executeWandboxMethod(room, playerA, tokenA, methodA, room.known.A) : null,
      methodB && !(room.suddenDeath && methodB.type === "defense") ? executeWandboxMethod(room, playerB, tokenB, methodB, room.known.B) : null,
    ]);
    const candidates = [
      { player: playerA, token: tokenA, method: methodA, execution: executionA },
      { player: playerB, token: tokenB, method: methodB, execution: executionB },
    ].filter((candidate) => candidate.token && candidate.method);

    candidates.sort((left, right) => {
      if (left.execution?.ok && !right.execution?.ok) return -1;
      if (!left.execution?.ok && right.execution?.ok) return 1;
      if (left.execution?.ok && right.execution?.ok) {
        const difference = left.execution.normalizedTime - right.execution.normalizedTime;
        if (Math.abs(difference) > 1e-6) return difference;
      }
      const preferred = room.turn % 2 === 1 ? "A" : "B";
      return left.player.side === preferred ? -1 : 1;
    });

    for (const candidate of candidates) {
      if (room.winner) break;
      if (candidate.token.hp <= 0) {
        room.events.push({ type: "skip", side: candidate.player.side, tokenId: candidate.token.id, reason: "destroyed" });
        continue;
      }
      if (room.suddenDeath && candidate.method.type === "defense") {
        room.events.push({ type: "skip", side: candidate.player.side, tokenId: candidate.token.id, reason: "defense-disabled" });
      } else if (!candidate.execution?.ok) {
        room.events.push({ type: "method-error", side: candidate.player.side, tokenId: candidate.token.id, methodId: candidate.method.id, status: candidate.execution?.status || "not-run", message: candidate.execution?.message || "メソッドを実行できませんでした。" });
      } else {
        applyExecution(room, candidate.player, candidate.token, candidate.method, candidate.execution);
      }
      candidate.token.activated = true;
    }
  }

  recomputeHp(playerA);
  recomputeHp(playerB);
  if (!room.winner && !room.suddenDeath && room.turn >= room.settings.maxTurns) {
    if (playerA.hp !== playerB.hp) room.winner = playerA.hp > playerB.hp ? "A" : "B";
    else room.suddenDeath = true;
  }
  room.events.push({ type: "resolution-end", hpA: playerA.hp, hpB: playerB.hp, winner: room.winner, suddenDeath: room.suddenDeath });
  room.phase = room.winner ? "finished" : "result";
  room.phaseDeadline = null;
  room.updatedAt = Date.now();
}

function startResolution(room) {
  if (room.resolvingPromise) return;
  room.resolvingPromise = resolveRoom(room)
    .catch((error) => {
      room.events.push({ type: "server-error", message: error.message });
      room.phase = "result";
      room.phaseDeadline = null;
    })
    .finally(() => { room.resolvingPromise = null; });
}

function finalizePlacements(room) {
  for (const player of room.players) ensurePlacement(room, player);
  startResolution(room);
}

function bothReady(room) {
  return room.players.length === 2 && room.players.every((player) => player.ready);
}

function advanceExpiredPhase(room) {
  if (!room.phaseDeadline || room.phaseDeadline > Date.now()) return;
  if (room.phase === "walls") {
    for (const player of room.players) player.ready = true;
    finalizeWalls(room);
  } else if (room.phase === "methods") {
    for (const player of room.players) player.ready = true;
    finalizeMethods(room);
  } else if (room.phase === "placement") {
    for (const player of room.players) {
      player.ready = true;
      ensurePlacement(room, player);
    }
    finalizePlacements(room);
  }
}

function cleanupRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [id, room] of rooms) if (room.updatedAt < cutoff) rooms.delete(id);
}

export async function handleDuelApi(request, response, url) {
  if (!url.pathname.startsWith("/api/")) return false;
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    response.end();
    return true;
  }

  cleanupRooms();
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, rooms: rooms.size, wandbox: WANDBOX_URL });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readJson(request);
      const { room, player } = createRoom(body.name, body.settings);
      sendJson(response, 201, { roomId: room.id, playerId: player.id, secret: player.secret, side: player.side });
      return true;
    }

    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/(join|state|walls|methods|placement|next))?$/i);
    if (!match) {
      sendJson(response, 404, { error: "APIが見つかりません。" });
      return true;
    }
    const room = getRoom(match[1]);
    advanceExpiredPhase(room);
    const action = match[2] || "state";

    if (request.method === "POST" && action === "join") {
      if (room.players.length >= 2) throw new Error("このルームは満員です。");
      const body = await readJson(request);
      const player = playerRecord("B", body.name, room.settings);
      room.players.push(player);
      beginTurn(room);
      sendJson(response, 200, { roomId: room.id, playerId: player.id, secret: player.secret, side: player.side });
      return true;
    }

    let credentials;
    if (request.method === "GET") {
      credentials = { playerId: url.searchParams.get("playerId"), secret: url.searchParams.get("secret") };
    } else {
      credentials = await readJson(request);
    }
    const player = authenticate(room, credentials.playerId, credentials.secret);

    if (request.method === "GET" && action === "state") {
      sendJson(response, 200, stateFor(room, player));
      return true;
    }
    if (request.method !== "POST") throw new Error("許可されていないHTTPメソッドです。");

    if (action === "walls") {
      if (room.phase !== "walls") throw new Error("現在は壁配置フェーズではありません。");
      player.wallCandidates = Array.isArray(credentials.walls) ? credentials.walls.slice(0, room.settings.wallLimit) : [];
      player.ready = Boolean(credentials.ready);
      if (bothReady(room)) finalizeWalls(room);
    } else if (action === "methods") {
      if (room.phase !== "methods") throw new Error("現在はメソッド構築フェーズではありません。");
      player.methods = sanitizeMethods(room, credentials.methods);
      player.ready = Boolean(credentials.ready);
      if (bothReady(room)) finalizeMethods(room);
    } else if (action === "placement") {
      if (room.phase !== "placement") throw new Error("現在はトークン配置フェーズではありません。");
      const result = validatePlacement({
        size: room.settings.gridSize,
        side: player.side,
        walls: room.walls,
        hp: player.hp,
        tokenLimit: room.settings.tokenLimit,
        tokens: credentials.tokens,
        methodIds: player.methods.map((method) => method.id),
      });
      if (!result.valid) throw new Error(result.reason);
      player.tokens = result.tokens;
      player.ready = Boolean(credentials.ready);
      if (bothReady(room)) finalizePlacements(room);
    } else if (action === "next") {
      if (room.phase !== "result") throw new Error("次ターンへ進める状態ではありません。");
      player.nextReady = true;
      if (room.players.every((candidate) => candidate.nextReady)) beginTurn(room);
    } else {
      throw new Error("API操作が見つかりません。");
    }

    room.updatedAt = Date.now();
    sendJson(response, 200, stateFor(room, player));
    return true;
  } catch (error) {
    sendJson(response, 400, { error: error.message || "リクエストを処理できませんでした。" });
    return true;
  }
}
