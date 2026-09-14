/**
 * Triplet — WebSocket + HTTP server (v2)
 *
 * Serves static files on HTTP and handles real-time game state
 * over raw WebSockets (ws package) on the same port.
 *
 * Start: node server.js
 * Default port: 3000 (set env PORT to override)
 */

"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { TripletGame } = require("./game-engine.js");

/* ═══════════════════════════════════════════════════════════════════
   Static file serving
═══════════════════════════════════════════════════════════════════ */

const STATIC = path.resolve(__dirname);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
};

const httpServer = http.createServer((req, res) => {
  const safePath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(STATIC, safePath);

  // Prevent directory traversal
  if (!filePath.startsWith(STATIC + path.sep) && filePath !== STATIC) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  const ext = path.extname(filePath);
  if (!MIME[ext]) { res.writeHead(404); res.end("Not found"); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[ext], "Cache-Control": "no-cache" });
    res.end(data);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Room & player management
═══════════════════════════════════════════════════════════════════ */

/**
 * @typedef {{ slot: number, cardId: string|null }} BoardSlot
 * @typedef {{ id: string, name: string, ws: WebSocket|null, connected: boolean, reconnectTimer: any }} RoomPlayer
 * @typedef {{ code: string, host: string, players: Map<string,RoomPlayer>, game: TripletGame|null, difficulty: string, turnTimerHandle: any, turnStartedAt: number|null }} Room
 */

/** @type {Map<string, Room>} */
const rooms = new Map();

/** @type {Map<WebSocket, {roomCode: string, playerId: string}>} */
const clientMeta = new Map();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // omit ambiguous 0OI1L

function genRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function genPlayerId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ═══════════════════════════════════════════════════════════════════
   WebSocket server
═══════════════════════════════════════════════════════════════════ */

const wss = new WebSocketServer({ server: httpServer });

/* ── Heartbeat (detect dead sockets) ── */
function onPong() { this.isAlive = true; }

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 5000);

wss.on("close", () => clearInterval(heartbeatInterval));

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", onPong.bind(ws));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on("close", () => handleDisconnect(ws));
  ws.on("error", () => { /* handled by close */ });
});

/* ═══════════════════════════════════════════════════════════════════
   Message helpers
═══════════════════════════════════════════════════════════════════ */

function send(ws, data) {
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(data));
  }
}

function sendError(ws, message) {
  send(ws, { type: "error", message });
}

/** Broadcast to all connected players in a room, optionally excluding one. */
function broadcast(room, payload, excludeId = null) {
  for (const [pid, rp] of room.players) {
    if (pid === excludeId || !rp.ws) continue;
    send(rp.ws, payload);
  }
}

/** Send personalized state to every connected player in the room. */
function broadcastState(room) {
  if (!room.game) return;
  for (const [pid, rp] of room.players) {
    if (!rp.ws) continue;
    send(rp.ws, { type: "state_update", state: sanitizeState(room, pid) });
  }
}

/** Helper: get the endpoint card ID for a player in a direction. */
function getEndpointId(game, player, direction) {
  if (!player.hand.length) return null;
  const ordered = game.sortCardIds(player.hand);
  return direction === "highest" ? ordered[ordered.length - 1] : ordered[0];
}

/**
 * Build a sanitized state snapshot for a specific player.
 * Private hands of OTHER players are hidden.
 */
function sanitizeState(room, forPlayerId) {
  const { game, difficulty } = room;
  if (!game) return null;

  const diffConfig = { normal: { setsToWin: 3, turnMs: 40000 }, hard: { setsToWin: 4, turnMs: 25000 } }[difficulty] || { setsToWin: 3, turnMs: 40000 };

  const players = game.players.map((p) => {
    const rp = room.players.get(p.id);
    const askedDirs = game.turn.askedPlayers.get(p.id) || new Set();
    return {
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      sets: [...p.sets],
      penalized: p.penalized,
      connected: rp ? rp.connected : false,
      isCurrentPlayer: p.id === game.currentPlayer.id,
      isMe: p.id === forPlayerId,
      hand: p.id === forPlayerId ? game.getHand(p.id) : null,
      highSeen: askedDirs.has("highest"),
      lowSeen:  askedDirs.has("lowest"),
    };
  });

  return {
    players,
    board: game.board.map((s) => ({ slot: s.slot, isEmpty: !s.cardId })),
    turn: {
      actions: game.turn.actions,
      maxActions: game.turn.maxActions,
      matrixFlipped: game.turn.matrixFlipped,
      seenSlots: [...game.turn.seenSlots],
    },
    currentPlayerId: game.currentPlayer.id,
    myPlayerId: forPlayerId,
    turnNumber: game.turnNumber,
    isFinished: game.isFinished,
    winnerId: game.winnerId,
    finishedReason: game.finishedReason,
    configuration: game.configuration,
    difficulty,
    diffConfig,
    turnStartedAt: room.turnStartedAt,
    remainingClues: game.getRemainingClues(),
    readyTriplets: game.currentPlayer.id === forPlayerId
      ? game.readyTriplets().map(String)
      : [],
    setsToWin: diffConfig.setsToWin,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   Turn timer
═══════════════════════════════════════════════════════════════════ */

const TURN_MS = { normal: 40000, hard: 25000 };

function startTurnTimer(room) {
  clearTurnTimer(room);
  room.turnStartedAt = Date.now();
  const ms = TURN_MS[room.difficulty] || 40000;

  room.turnTimerHandle = setTimeout(() => {
    if (!room.game || room.game.isFinished) return;
    const expiredName = room.game.currentPlayer.name;
    try {
      room.game._forceAdvanceTurn();
    } catch (_) { /* already finished */ }
    broadcastState(room);
    broadcast(room, { type: "toast", message: `⏱ ${expiredName}'s time ran out — turn skipped.`, isError: true });
    if (!room.game.isFinished) startTurnTimer(room);
  }, ms);
}

function clearTurnTimer(room) {
  if (room.turnTimerHandle) { clearTimeout(room.turnTimerHandle); room.turnTimerHandle = null; }
}

function resetTurnTimer(room) {
  // Reset after each clue action (keeps pressure on)
  startTurnTimer(room);
}

/* ═══════════════════════════════════════════════════════════════════
   Disconnect handling
═══════════════════════════════════════════════════════════════════ */

function handleDisconnect(ws) {
  const meta = clientMeta.get(ws);
  if (!meta) return;
  clientMeta.delete(ws);

  const room = rooms.get(meta.roomCode);
  if (!room) return;

  const rp = room.players.get(meta.playerId);
  if (!rp) return;

  rp.connected = false;
  rp.ws = null;

  broadcast(room, { type: "player_left", playerId: meta.playerId, name: rp.name, playerList: playerList(room) });
  broadcastState(room);

  // 60-second grace period to reconnect
  rp.reconnectTimer = setTimeout(() => {
    room.players.delete(meta.playerId);
    if (room.players.size === 0 || [...room.players.values()].every((p) => !p.connected)) {
      clearTurnTimer(room);
      rooms.delete(room.code);
      console.log(`[room ${room.code}] closed (all disconnected)`);
    }
  }, 60_000);
}

function playerList(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, connected: p.connected }));
}

/* ═══════════════════════════════════════════════════════════════════
   Main message dispatcher
═══════════════════════════════════════════════════════════════════ */

function handleMessage(ws, msg) {
  const { type } = msg;

  /* ── Ping ── */
  if (type === "ping") { send(ws, { type: "pong" }); return; }

  /* ── Create room ── */
  if (type === "create_room") {
    const name       = sanitizeName(msg.name);
    const difficulty = msg.difficulty === "hard" ? "hard" : "normal";
    const code       = genRoomCode();
    const playerId   = genPlayerId();

    const rp = { id: playerId, name, ws, connected: true, reconnectTimer: null };
    const room = {
      code, host: playerId,
      players: new Map([[playerId, rp]]),
      game: null, difficulty,
      turnTimerHandle: null, turnStartedAt: null,
    };
    rooms.set(code, room);
    clientMeta.set(ws, { roomCode: code, playerId });

    send(ws, { type: "room_created", code, playerId, isHost: true, difficulty, playerList: playerList(room) });
    console.log(`[room ${code}] created by ${name} (${difficulty})`);
    return;
  }

  /* ── Join room ── */
  if (type === "join_room") {
    const code = String(msg.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const name = sanitizeName(msg.name);
    const room = rooms.get(code);

    if (!room) { sendError(ws, "Room not found. Double-check the code."); return; }

    // Reconnect attempt (game already running)
    if (room.game) {
      for (const [pid, rp] of room.players) {
        if (rp.name.toLowerCase() === name.toLowerCase() && !rp.connected) {
          clearTimeout(rp.reconnectTimer);
          rp.ws = ws;
          rp.connected = true;
          clientMeta.set(ws, { roomCode: code, playerId: pid });
          send(ws, { type: "rejoined", playerId: pid, code, difficulty: room.difficulty, playerList: playerList(room) });
          broadcast(room, { type: "player_rejoined", playerId: pid, name, playerList: playerList(room) }, pid);
          send(ws, { type: "state_update", state: sanitizeState(room, pid) });
          console.log(`[room ${code}] ${name} reconnected`);
          return;
        }
      }
      sendError(ws, "Game in progress. You can only rejoin with your exact original name."); return;
    }

    if (room.players.size >= 5) { sendError(ws, "This room is full (max 5 players)."); return; }

    const playerId = genPlayerId();
    const rp = { id: playerId, name, ws, connected: true, reconnectTimer: null };
    room.players.set(playerId, rp);
    clientMeta.set(ws, { roomCode: code, playerId });

    const list = playerList(room);
    send(ws, { type: "room_joined", code, playerId, isHost: false, difficulty: room.difficulty, playerList: list });
    broadcast(room, { type: "player_joined", playerId, name, playerList: list }, playerId);
    console.log(`[room ${code}] ${name} joined (${room.players.size} players)`);
    return;
  }

  /* ── All subsequent messages require room membership ── */
  const meta = clientMeta.get(ws);
  if (!meta) { sendError(ws, "You are not in a room."); return; }

  const room = rooms.get(meta.roomCode);
  if (!room)  { sendError(ws, "Room not found."); return; }

  const { playerId } = meta;

  /* ── Start game ── */
  if (type === "start_game") {
    if (playerId !== room.host) { sendError(ws, "Only the host can start the game."); return; }
    if (room.game) { sendError(ws, "Game already in progress."); return; }
    if (room.players.size < 3) { sendError(ws, `Need at least 3 players — you have ${room.players.size}.`); return; }

    const rpList = [...room.players.values()];
    try {
      room.game = new TripletGame({
        playerNames: rpList.map((p) => p.name),
        playerIds:   rpList.map((p) => p.id),
        difficulty:  room.difficulty,
      });
    } catch (e) { sendError(ws, e.message); return; }

    broadcast(room, { type: "game_started", difficulty: room.difficulty });
    broadcastState(room);
    startTurnTimer(room);
    console.log(`[room ${room.code}] game started (${room.players.size} players, ${room.difficulty})`);
    return;
  }

  /* ── In-game moves ── */
  if (!room.game)            { sendError(ws, "Game has not started yet."); return; }
  if (room.game.isFinished)  { sendError(ws, "The game is already over."); return; }
  if (room.game.currentPlayer.id !== playerId) { sendError(ws, "It is not your turn."); return; }

  /* ── Ask ── */
  if (type === "ask") {
    try {
      const result = room.game.ask(msg.targetId, msg.direction);
      const target = room.game.getPlayer(msg.targetId);
      broadcastState(room);
      broadcast(room, {
        type: "reveal",
        title: `${target.name}'s ${msg.direction} card`,
        card: result.card,
        duration: room.difficulty === "hard" ? 3000 : 4000,
      });
      if (result.bonus) broadcast(room, { type: "toast", message: `🎉 Bonus clue! ${room.game.currentPlayer.name} gets a 3rd clue this turn.` });
      resetTurnTimer(room);
    } catch (e) { sendError(ws, e.message); }
    return;
  }

  /* ── Flip matrix ── */
  if (type === "flip") {
    try {
      const result = room.game.flip(Number(msg.slot));
      broadcastState(room);
      broadcast(room, {
        type: "reveal",
        title: `Matrix card ${Number(msg.slot) + 1}${result.free ? " (free flip)" : ""}`,
        card: result.card,
        slot: Number(msg.slot),
        duration: room.difficulty === "hard" ? 3000 : 4000,
      });
      if (result.bonus) broadcast(room, { type: "toast", message: `🎉 Bonus clue! ${room.game.currentPlayer.name} gets a 3rd clue this turn.` });
      if (!result.free) resetTurnTimer(room);
    } catch (e) { sendError(ws, e.message); }
    return;
  }

  /* ── Claim triplet ── */
  if (type === "claim_triplet") {
    try {
      const result = room.game.claimTriplet(msg.value);
      if (result.winner) {
        clearTurnTimer(room);
        broadcastState(room);
        broadcast(room, { type: "toast", message: `🏆 ${result.winner.name} WINS the table!` });
      } else {
        broadcastState(room);
        broadcast(room, { type: "toast", message: `✅ Triplet "${result.value}" claimed! Now ${room.game.currentPlayer.name}'s turn.` });
        startTurnTimer(room);
      }
    } catch (e) {
      // Wrong claim: apply penalty
      sendError(ws, e.message);
      try {
        const offender = room.game.getPlayer(playerId);
        offender.penalized = true;
        room.game._record({ type: "penalty", actorId: playerId, message: `${offender.name} called a wrong triplet — loses next turn.` });
        broadcastState(room);
        broadcast(room, { type: "toast", message: `❌ Wrong call by ${offender.name}! They lose their next turn.`, isError: true });
      } catch (_) { /* player may have left */ }
    }
    return;
  }

  /* ── End turn ── */
  if (type === "end_turn") {
    try {
      const leaving = room.game.currentPlayer.name;
      room.game.endTurn();
      broadcastState(room);
      broadcast(room, { type: "toast", message: `${leaving} ended their turn. Now ${room.game.currentPlayer.name}'s turn.` });
      startTurnTimer(room);
    } catch (e) { sendError(ws, e.message); }
    return;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Utilities
═══════════════════════════════════════════════════════════════════ */

function sanitizeName(raw) {
  return String(raw || "Player").trim().replace(/</g, "").replace(/>/g, "").slice(0, 18) || "Player";
}

/* ═══════════════════════════════════════════════════════════════════
   Start server
═══════════════════════════════════════════════════════════════════ */

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, () => {
  console.log("─────────────────────────────────────────");
  console.log(`  Triplet server v2 running`);
  console.log(`  HTTP: http://localhost:${PORT}`);
  console.log(`  WS:   ws://localhost:${PORT}`);
  console.log("─────────────────────────────────────────");
});
