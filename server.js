/**
 * Time Trotter — WebSocket + HTTP server (v2.1)
 *
 * FEATURES (v2.1):
 *  - Quick Match: auto-pairs solo players into waiting rooms
 *  - Host transfer: if host disconnects, next player becomes host
 *  - GET /api/rooms: lobby browser (public room list)
 *  - Improved MIME support (jpeg, png, ico)
 *  - Room cleanup on empty + stale room GC every 5 min
 *  - Lobby chat (type: "chat") in waiting room
 *  - Server stats endpoint GET /api/stats
 */

"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { TimeTrotterGame, TripletGame } = require("./game-engine.js");

/* ═══════════════════════════════════════════════════════════════════
   Static file serving
═══════════════════════════════════════════════════════════════════ */

const STATIC = path.resolve(__dirname);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico":  "image/x-icon",
  ".svg":  "image/svg+xml",
  ".woff2":"font/woff2",
};

const httpServer = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  /* ── REST API ── */
  if (url === "/api/rooms") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    const list = [...rooms.values()]
      .filter(r => !r.game)                          // only open lobbies
      .map(r => ({
        code:       r.code,
        difficulty: r.difficulty,
        players:    r.players.size,
        maxPlayers: 5,
        host:       [...r.players.values()][0]?.name || "?",
        createdAt:  r.createdAt,
      }));
    res.end(JSON.stringify(list));
    return;
  }

  if (url === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      rooms:        rooms.size,
      activeGames:  [...rooms.values()].filter(r => r.game && !r.game.isFinished).length,
      connectedWS:  wss.clients.size,
      uptime:       Math.round(process.uptime()),
    }));
    return;
  }

  /* ── Static files ── */
  const safePath = url === "/" ? "/index.html" : url;
  const filePath = path.join(STATIC, safePath);

  if (!filePath.startsWith(STATIC + path.sep) && filePath !== STATIC) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  const ext = path.extname(filePath).toLowerCase();
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

/** @type {Map<string, object>} */
const rooms = new Map();

/** @type {Map<WebSocket, {roomCode: string, playerId: string}>} */
const clientMeta = new Map();

/** Quick Match queues: one per difficulty */
const quickMatchQueues = { normal: null, hard: null }; // roomCode | null

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function genRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function genPlayerId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function createRoom(hostWs, hostName, difficulty) {
  const code      = genRoomCode();
  const playerId  = genPlayerId();
  const rp = { id: playerId, name: hostName, ws: hostWs, connected: true, reconnectTimer: null };
  const room = {
    code,
    host:            playerId,
    players:         new Map([[playerId, rp]]),
    game:            null,
    difficulty,
    turnTimerHandle: null,
    turnStartedAt:   null,
    createdAt:       Date.now(),
    chatLog:         [],          // [{name, text, ts}] last 50
  };
  rooms.set(code, room);
  clientMeta.set(hostWs, { roomCode: code, playerId });
  return { room, playerId };
}

function playerList(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, connected: p.connected,
    isHost: p.id === room.host,
  }));
}

/* Host transfer: assign next connected player as host */
function transferHost(room) {
  for (const [pid, rp] of room.players) {
    if (pid !== room.host && rp.connected) {
      room.host = pid;
      broadcast(room, {
        type:    "host_changed",
        newHost: pid,
        name:    rp.name,
        message: `${rp.name} is now the host.`,
        playerList: playerList(room),
      });
      console.log(`[room ${room.code}] host transferred to ${rp.name}`);
      return;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   WebSocket server
═══════════════════════════════════════════════════════════════════ */

const wss = new WebSocketServer({ server: httpServer });

/* ── Heartbeat (detect dead sockets, 5s interval) ── */
function onPong() { this.isAlive = true; }

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 5000);

/* ── Stale room GC (every 5 min) ── */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const allGone   = [...room.players.values()].every(p => !p.connected);
    const staleOpen = !room.game && now - room.createdAt > 30 * 60 * 1000; // 30 min empty lobby
    if (allGone || staleOpen) {
      clearTurnTimer(room);
      rooms.delete(code);
      console.log(`[room ${code}] GC removed (allGone=${allGone}, staleOpen=${staleOpen})`);
    }
  }
}, 5 * 60 * 1000);

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
  if (ws && ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(data));
}

function sendError(ws, message) {
  send(ws, { type: "error", message });
}

function broadcast(room, payload, excludeId = null) {
  for (const [pid, rp] of room.players) {
    if (pid === excludeId || !rp.ws) continue;
    send(rp.ws, payload);
  }
}

function broadcastState(room) {
  if (!room.game) return;
  for (const [pid, rp] of room.players) {
    if (!rp.ws) continue;
    send(rp.ws, { type: "state_update", state: sanitizeState(room, pid) });
  }
}

function sanitizeState(room, forPlayerId) {
  const { game, difficulty } = room;
  if (!game) return null;

  const diffConfig = {
    normal: { setsToWin: 3, turnMs: 40000, revealMs: 4000, decayRounds: 5 },
    hard:   { setsToWin: 4, turnMs: 25000, revealMs: 3000, decayRounds: 3 },
  }[difficulty] || { setsToWin: 3, turnMs: 40000, revealMs: 4000, decayRounds: 5 };

  const players = game.players.map(p => {
    const rp       = room.players.get(p.id);
    const askedDir = game.turn.askedPlayers.get(p.id) || new Set();
    return {
      id:              p.id,
      name:            p.name,
      handCount:       p.hand.length,
      sets:            [...p.sets],
      penalized:       p.penalized,
      connected:       rp ? rp.connected : false,
      isCurrentPlayer: p.id === game.currentPlayer.id,
      isMe:            p.id === forPlayerId,
      isHost:          p.id === room.host,
      hand:            p.id === forPlayerId ? game.getHand(p.id) : null,
      highSeen:        askedDir.has("highest"),
      lowSeen:         askedDir.has("lowest"),
    };
  });

  return {
    players,
    board: game.board.map(s => ({ slot: s.slot, isEmpty: !s.cardId })),
    turn: {
      actions:       game.turn.actions,
      maxActions:    game.turn.maxActions,
      seenSlots:     [...game.turn.seenSlots],
    },
    currentPlayerId: game.currentPlayer.id,
    myPlayerId:      forPlayerId,
    hostId:          room.host,
    turnNumber:      game.turnNumber,
    isFinished:      game.isFinished,
    winnerId:        game.winnerId,
    finishedReason:  game.finishedReason,
    configuration:   game.configuration,
    difficulty,
    diffConfig,
    turnStartedAt:   room.turnStartedAt,
    remainingClues:  game.getRemainingClues(),
    readyTriplets:   game.currentPlayer.id === forPlayerId
                       ? game.readyTriplets().map(String)
                       : [],
    setsToWin:       diffConfig.setsToWin,
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
    try { room.game._forceAdvanceTurn(); } catch (_) {}
    broadcastState(room);
    broadcast(room, { type: "toast", message: `⏱ ${expiredName}'s time ran out — turn skipped.`, isError: true });
    if (!room.game.isFinished) startTurnTimer(room);
  }, ms);
}

function clearTurnTimer(room) {
  if (room.turnTimerHandle) { clearTimeout(room.turnTimerHandle); room.turnTimerHandle = null; }
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

  // If disconnected player was host → transfer host
  if (meta.playerId === room.host) transferHost(room);

  // Broadcast updated state (connection dots)
  if (room.game) broadcastState(room);

  // Clear from quick-match queue if they were the queued room
  for (const diff of ["normal", "hard"]) {
    if (quickMatchQueues[diff] === room.code && room.players.size === 0) {
      quickMatchQueues[diff] = null;
    }
  }

  // 60-second grace period to reconnect
  rp.reconnectTimer = setTimeout(() => {
    room.players.delete(meta.playerId);
    const allGone = room.players.size === 0 || [...room.players.values()].every(p => !p.connected);
    if (allGone) {
      clearTurnTimer(room);
      rooms.delete(room.code);
      // also clear from QM queue
      for (const diff of ["normal", "hard"]) {
        if (quickMatchQueues[diff] === room.code) quickMatchQueues[diff] = null;
      }
      console.log(`[room ${room.code}] closed (empty after grace period)`);
    }
  }, 60_000);
}

/* ═══════════════════════════════════════════════════════════════════
   Main message dispatcher
═══════════════════════════════════════════════════════════════════ */

function handleMessage(ws, msg) {
  const { type } = msg;

  /* ── Ping ── */
  if (type === "ping") { send(ws, { type: "pong", serverTime: Date.now() }); return; }

  /* ── Browse rooms ── */
  if (type === "browse_rooms") {
    const list = [...rooms.values()]
      .filter(r => !r.game && r.players.size < 5)
      .map(r => ({
        code:       r.code,
        difficulty: r.difficulty,
        players:    r.players.size,
        host:       [...r.players.values()][0]?.name || "?",
      }));
    send(ws, { type: "room_list", rooms: list });
    return;
  }

  /* ── Create room ── */
  if (type === "create_room") {
    const name       = sanitizeName(msg.name);
    const difficulty = msg.difficulty === "hard" ? "hard" : "normal";
    const { room, playerId } = createRoom(ws, name, difficulty);

    send(ws, {
      type: "room_created", code: room.code,
      playerId, isHost: true, difficulty,
      playerList: playerList(room),
    });
    console.log(`[room ${room.code}] created by ${name} (${difficulty})`);
    return;
  }

  /* ── Quick Match ── */
  if (type === "quick_match") {
    const name       = sanitizeName(msg.name);
    const difficulty = msg.difficulty === "hard" ? "hard" : "normal";
    const queueCode  = quickMatchQueues[difficulty];
    const queueRoom  = queueCode ? rooms.get(queueCode) : null;

    if (queueRoom && !queueRoom.game && queueRoom.players.size < 5) {
      // ── Join the queued room ──
      const playerId = genPlayerId();
      const rp = { id: playerId, name, ws, connected: true, reconnectTimer: null };
      queueRoom.players.set(playerId, rp);
      clientMeta.set(ws, { roomCode: queueCode, playerId });

      const list = playerList(queueRoom);
      send(ws, { type: "room_joined", code: queueCode, playerId, isHost: false, difficulty, playerList: list, quickMatch: true });
      broadcast(queueRoom, { type: "player_joined", playerId, name, playerList: list }, playerId);
      console.log(`[room ${queueCode}] Quick Match: ${name} joined (${queueRoom.players.size} players)`);

      // If room now has ≥3 and is "full enough" for auto-start, notify host
      if (queueRoom.players.size >= 3) {
        broadcast(queueRoom, { type: "toast", message: `${queueRoom.players.size} players ready! Host can start the game.` });
      }
      // Stop queuing this room once full
      if (queueRoom.players.size >= 5) quickMatchQueues[difficulty] = null;

    } else {
      // ── Create a new room and queue it ──
      const { room, playerId } = createRoom(ws, name, difficulty);
      quickMatchQueues[difficulty] = room.code;
      send(ws, {
        type: "room_created", code: room.code,
        playerId, isHost: true, difficulty,
        playerList: playerList(room), quickMatch: true,
      });
      broadcast(room, { type: "toast", message: "Finding other players… share your room code too!" });
      console.log(`[room ${room.code}] Quick Match queue opened by ${name} (${difficulty})`);
    }
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
          send(ws, { type: "rejoined", playerId: pid, code, difficulty: room.difficulty, playerList: playerList(room), isHost: pid === room.host });
          broadcast(room, { type: "player_rejoined", playerId: pid, name, playerList: playerList(room) }, pid);
          send(ws, { type: "state_update", state: sanitizeState(room, pid) });
          console.log(`[room ${code}] ${name} reconnected`);
          return;
        }
      }
      sendError(ws, "Game in progress. Rejoin with your exact original name."); return;
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

  /* ── Lobby chat ── */
  if (type === "chat") {
    if (room.game) return; // no chat during game
    const rp  = room.players.get(playerId);
    if (!rp) return;
    const text = String(msg.text || "").trim().slice(0, 200);
    if (!text) return;
    const entry = { name: rp.name, text, ts: Date.now() };
    room.chatLog.push(entry);
    if (room.chatLog.length > 50) room.chatLog.shift();
    broadcast(room, { type: "chat", ...entry });
    return;
  }

  /* ── Kick player (host only, pre-game) ── */
  if (type === "kick_player") {
    if (playerId !== room.host) { sendError(ws, "Only the host can kick players."); return; }
    if (room.game) { sendError(ws, "Cannot kick during a game."); return; }
    const targetId = msg.targetId;
    const target   = room.players.get(targetId);
    if (!target || targetId === playerId) { sendError(ws, "Invalid kick target."); return; }
    if (target.ws) send(target.ws, { type: "kicked", message: "You were removed from the room by the host." });
    room.players.delete(targetId);
    clientMeta.delete(target.ws);
    const list = playerList(room);
    broadcast(room, { type: "player_kicked", playerId: targetId, name: target.name, playerList: list });
    return;
  }

  /* ── Transfer host (host only) ── */
  if (type === "transfer_host") {
    if (playerId !== room.host) { sendError(ws, "Only the host can transfer host."); return; }
    if (room.game) { sendError(ws, "Cannot transfer host during a game."); return; }
    const newHostId = msg.targetId;
    if (!room.players.has(newHostId)) { sendError(ws, "Player not found."); return; }
    room.host = newHostId;
    const list = playerList(room);
    broadcast(room, { type: "host_changed", newHost: newHostId, name: room.players.get(newHostId).name, message: `${room.players.get(newHostId).name} is now the host.`, playerList: list });
    return;
  }

  /* ── Start game ── */
  if (type === "start_game") {
    if (playerId !== room.host) { sendError(ws, "Only the host can start the game."); return; }
    if (room.game) { sendError(ws, "Game already in progress."); return; }
    if (room.players.size < 3) { sendError(ws, `Need at least 3 players — you have ${room.players.size}.`); return; }

    const rpList = [...room.players.values()];
    try {
      room.game = new TimeTrotterGame({
        playerNames: rpList.map(p => p.name),
        playerIds:   rpList.map(p => p.id),
        difficulty:  room.difficulty,
      });
    } catch (e) { sendError(ws, e.message); return; }

    // Clear from quick-match queue once started
    if (quickMatchQueues[room.difficulty] === room.code) quickMatchQueues[room.difficulty] = null;

    broadcast(room, { type: "game_started", difficulty: room.difficulty });
    broadcastState(room);
    startTurnTimer(room);
    console.log(`[room ${room.code}] game started (${room.players.size}p, ${room.difficulty})`);
    return;
  }

  /* ── In-game moves ── */
  if (!room.game)           { sendError(ws, "Game has not started yet."); return; }
  if (room.game.isFinished) { sendError(ws, "The game is already over."); return; }
  if (room.game.currentPlayer.id !== playerId) { sendError(ws, "It is not your turn."); return; }

  const revealDuration = room.difficulty === "hard" ? 3000 : 4000;

  /* ── Ask ── */
  if (type === "ask") {
    try {
      const result = room.game.ask(msg.targetId, msg.direction);
      const target = room.game.getPlayer(msg.targetId);
      broadcastState(room);
      broadcast(room, { type: "reveal", title: `${target.name}'s ${msg.direction} card`, card: result.card, duration: revealDuration });
      if (result.bonus) broadcast(room, { type: "toast", message: `🎉 Bonus clue! ${room.game.currentPlayer.name} gets a 3rd clue this turn.` });
      startTurnTimer(room); // reset timer on every action
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
        title: `Matrix card ${Number(msg.slot) + 1}`,
        card: result.card, slot: Number(msg.slot),
        duration: revealDuration,
      });
      if (result.bonus) broadcast(room, { type: "toast", message: `🎉 Bonus guess! Both revealed cards matched ${result.card.value}! 3rd guess awarded.` });
      startTurnTimer(room);
    } catch (e) { sendError(ws, e.message); }
    return;
  }

  /* ── Claim triplet ── */
  if (type === "claim_triplet") {
    try {
      const result = room.game.claimTriplet(msg.value);
      if (result.wrongCall) {
        broadcastState(room);
        broadcast(room, {
          type: "toast",
          message: `❌ Wrong call by ${result.penalisedPlayer.name} (${msg.value})! Next turn skipped. Now ${room.game.currentPlayer.name}'s turn.`,
          isError: true,
        });
        startTurnTimer(room);
      } else if (result.winner) {
        clearTurnTimer(room);
        broadcastState(room);
        broadcast(room, { type: "game_over", winnerId: result.winner.id, winnerName: result.winner.name });
        broadcast(room, { type: "toast", message: `🏆 ${result.winner.name} WINS the table!` });
      } else {
        broadcastState(room);
        broadcast(room, { type: "toast", message: `✅ Triplet "${result.value}" claimed! Now ${room.game.currentPlayer.name}'s turn.` });
        startTurnTimer(room);
      }
    } catch (e) {
      sendError(ws, e.message);
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
  return String(raw || "Player").trim().replace(/[<>]/g, "").slice(0, 18) || "Player";
}

/* ═══════════════════════════════════════════════════════════════════
   Start server
═══════════════════════════════════════════════════════════════════ */

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, () => {
  console.log("─────────────────────────────────────────────");
  console.log(`  Time Trotter server v2.1`);
  console.log(`  HTTP:  http://localhost:${PORT}`);
  console.log(`  WS:    ws://localhost:${PORT}`);
  console.log(`  Rooms: http://localhost:${PORT}/api/rooms`);
  console.log(`  Stats: http://localhost:${PORT}/api/stats`);
  console.log("─────────────────────────────────────────────");
});
