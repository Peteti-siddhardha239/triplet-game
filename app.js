/**
 * Triplet App v2 — Dual-mode controller
 *
 * - Online mode : WebSocket client → server is authoritative
 * - Offline mode: local TripletGame instance (pass-and-play)
 *
 * Flow:
 *   modeSelect → [online] onlineLobby → waitingRoom → game
 *             → [offline] lobby → game
 */
(function runTripletApp() {
  "use strict";

  const { TimeTrotterGame, TripletGame, CONFIGURATIONS, VALUES } = window.TimeTrotterEngine || window.TripletEngine;

  /* ─────────────────────────────────────────────────────────────
     DOM helpers
  ───────────────────────────────────────────────────────────── */
  const $  = (id)  => document.getElementById(id);
  const $$ = (sel, ctx = document) => ctx.querySelector(sel);

  /* ─────────────────────────────────────────────────────────────
     Global state
  ───────────────────────────────────────────────────────────── */
  let mode           = null;    // 'online' | 'offline'
  let ws             = null;
  let wsReady        = false;
  let myPlayerId     = null;
  let myRoomCode     = null;
  let isHost         = false;
  let onlineState    = null;    // latest state_update from server
  let waitingPlayers = [];      // [{id,name,connected}]
  let selectedDiff   = "normal";
  let isQuickMatch   = false;   // joined via Quick Match

  // Offline state
  let game          = null;
  let selectedCount = 3;

  // Shared UI timers
  let toastTimer    = null;
  let revealTimer   = null;
  let timerRaf      = null;
  let pingStart     = null;
  let pingInterval  = null;
  let reconnTimer   = null;
  let reconnDelay   = 1000;

  // Reveal state (shared offline + online)
  let previewSlot   = null;   // matrix slot currently face-up
  let activeReveal  = null;   // {title,card,slot}

  /* ─────────────────────────────────────────────────────────────
     Utility
  ───────────────────────────────────────────────────────────── */
  function esc(v) {
    return String(v)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;")
      .replace(/'/g,"&#039;");
  }

  function cardMarkup(card) {
    return `<div class="playing-card ${card.colour}" aria-label="${esc(card.value)} ${card.colour}">
      <span class="card-corner top">${esc(card.value)}</span>
      <span class="uno-oval"><span>${esc(card.value)}</span></span>
      <span class="card-corner bottom">${esc(card.value)}</span>
    </div>`;
  }

  function isRevealActive() {
    return Boolean(activeReveal || previewSlot !== null);
  }

  function showToast(msg, isError = false) {
    clearTimeout(toastTimer);
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("error", isError);
    t.classList.add("visible");
    toastTimer = setTimeout(() => t.classList.remove("visible"), 4800);
  }

  /**
   * Show the card-reveal popup for `duration` ms.
   * Also highlights the matrix slot if slot !== null.
   */
  function beginTimedReveal({ title = null, card = null, slot = null, duration = 4000 }) {
    clearTimeout(revealTimer);
    activeReveal = (title && card) ? { title, card, slot } : null;
    previewSlot  = slot;

    const popup = $("revealPopup");
    if (activeReveal) {
      $("revealTitle").textContent    = activeReveal.title;
      $("revealSubtitle").textContent = `Everyone has ${Math.round(duration / 1000)} seconds.`;
      $("revealCard").innerHTML       = cardMarkup(activeReveal.card);
      const bar = $("revealProgressBar");
      bar.style.setProperty("--reveal-duration", `${duration / 1000}s`);
      bar.style.animation = "none";
      bar.offsetHeight;           // force reflow to restart animation
      bar.style.animation = "";
      popup.hidden = false;
    } else {
      popup.hidden = true;
    }

    // Refresh matrix + actions during reveal (buttons disabled while popup is open)
    refreshMatrix();
    refreshActions();

    revealTimer = setTimeout(() => {
      activeReveal = null;
      previewSlot  = null;
      popup.hidden = true;
      refreshMatrix();
      refreshActions();
    }, duration);
  }

  function refreshMatrix() {
    if (mode === "online") renderOnlineMatrix();
    else                   renderOfflineMatrix();
  }

  function refreshActions() {
    if (mode === "online") renderOnlineActions();
    else                   renderOfflineActions();
  }

  /* ─────────────────────────────────────────────────────────────
     Screen management
  ───────────────────────────────────────────────────────────── */
  const SCREENS = ["modeSelect","onlineLobby","waitingRoom","lobby","game"];

  function showOnly(id) {
    SCREENS.forEach(s => { const el = $(s); if (el) el.hidden = (s !== id); });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ─────────────────────────────────────────────────────────────
     WebSocket client
  ───────────────────────────────────────────────────────────── */
  function connectWS() {
    clearTimeout(reconnTimer);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const port  = location.port || "3000";
    const url   = `${proto}//${location.hostname}:${port}`;

    try {
      ws = new WebSocket(url);
    } catch (e) {
      setConnStatus("error");
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      wsReady      = true;
      reconnDelay  = 1000;
      setConnStatus("connected");
      startPingLoop();
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMsg(msg);
    };

    ws.onclose = () => {
      wsReady = false;
      ws      = null;
      stopPingLoop();
      if (mode === "online") {
        setConnStatus("reconnecting");
        scheduleReconnect();
      }
    };

    ws.onerror = () => { /* handled by onclose */ };
  }

  function scheduleReconnect() {
    clearTimeout(reconnTimer);
    reconnTimer = setTimeout(() => {
      connectWS();
      reconnDelay = Math.min(reconnDelay * 2, 30000);
    }, reconnDelay);
  }

  function sendWS(data) {
    if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      return true;
    }
    showToast("Not connected — reconnecting…", true);
    return false;
  }

  function startPingLoop() {
    stopPingLoop();
    pingInterval = setInterval(() => {
      if (!wsReady) return;
      pingStart = Date.now();
      sendWS({ type: "ping" });
    }, 5000);
  }

  function stopPingLoop() {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  }

  function setConnStatus(status) {
    const el = $("connStatus");
    if (!el) return;
    el.hidden = (mode !== "online");
    $("connDot").className = `conn-dot ${status}`;
    $("connLabel").textContent = { connected:"Connected", reconnecting:"Reconnecting…", error:"Offline" }[status] || status;
  }

  /* ─────────────────────────────────────────────────────────────
     Server message handler
  ───────────────────────────────────────────────────────────── */
  function handleServerMsg(msg) {
    switch (msg.type) {

      case "pong":
        if (pingStart) {
          $("connPing").textContent = `${Date.now() - pingStart}ms`;
          pingStart = null;
        }
        break;

      case "room_created":
        myPlayerId     = msg.playerId;
        myRoomCode     = msg.code;
        isHost         = true;
        isQuickMatch   = !!msg.quickMatch;
        selectedDiff   = msg.difficulty || "normal";
        waitingPlayers = msg.playerList || [];
        showWaitingRoom();
        break;

      case "room_joined":
        myPlayerId     = msg.playerId;
        myRoomCode     = msg.code;
        isHost         = false;
        isQuickMatch   = !!msg.quickMatch;
        selectedDiff   = msg.difficulty || "normal";
        waitingPlayers = msg.playerList || [];
        showWaitingRoom();
        break;

      case "rejoined":
        myPlayerId = msg.playerId;
        isHost     = msg.isHost || false;
        // state_update will arrive next
        break;

      case "host_changed":
        waitingPlayers = msg.playerList || waitingPlayers;
        isHost = (myPlayerId === msg.newHost);
        if (!$("waitingRoom").hidden) {
          renderWaitingList();
          updateStartBtn();
          $('startOnlineGame').hidden = !isHost;
          $('waitingHint').textContent = isHost
            ? 'You are now the host. Press Start when ready.'
            : 'Waiting for the host to start…';
        }
        showToast(msg.message || `${msg.name} is now the host.`);
        break;

      case "kicked":
        showToast(msg.message || 'You were removed from the room.', true);
        if (ws) { ws.close(); ws = null; wsReady = false; }
        myPlayerId = null; myRoomCode = null; isHost = false;
        onlineState = null; waitingPlayers = [];
        mode = null;
        $('connStatus').hidden = true;
        showOnly('modeSelect');
        break;

      case "game_over":
        // state_update handles rendering; just show celebration toast
        if (msg.winnerName) showToast(`🏆 ${msg.winnerName} wins the game!`);
        break;

      case "chat":
        appendChatMessage(msg.name, msg.text, msg.ts);
        break;

      case "room_list":
        renderRoomBrowser(msg.rooms || []);
        break;

      case "player_joined":
        waitingPlayers = msg.playerList || waitingPlayers;
        if (!$("waitingRoom").hidden) { renderWaitingList(); updateStartBtn(); }
        showToast(`${msg.name} joined the room!`);
        break;

      case "player_left":
        waitingPlayers = msg.playerList || waitingPlayers;
        if (!$("waitingRoom").hidden) { renderWaitingList(); updateStartBtn(); }
        showToast(`${msg.name} left the room.`);
        if (!$("game").hidden && onlineState) renderOnlineGame();  // refresh conn dots
        break;

      case "player_rejoined":
        waitingPlayers = msg.playerList || waitingPlayers;
        showToast(`${msg.name} reconnected! ✓`);
        if (!$("game").hidden && onlineState) renderOnlineGame();
        break;

      case "game_started":
        $("difficultyBadge").hidden = (msg.difficulty !== "hard");
        $("turnTimerWrap").hidden   = false;
        showOnly("game");
        break;

      case "state_update":
        onlineState = msg.state;
        if (!onlineState) break;
        // If still in waiting room (game just started), switch to game view
        if (!$("game").hidden) {
          renderOnlineGame();
        } else {
          $("difficultyBadge").hidden = (onlineState.difficulty !== "hard");
          $("turnTimerWrap").hidden   = false;
          showOnly("game");
          renderOnlineGame();
        }
        break;

      case "reveal":
        beginTimedReveal({
          title:    msg.title,
          card:     msg.card,
          slot:     msg.slot !== undefined ? msg.slot : null,
          duration: msg.duration || 4000,
        });
        break;

      case "toast":
        showToast(msg.message, msg.isError || false);
        break;

      case "error":
        showToast(msg.message, true);
        break;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     Waiting Room
  ───────────────────────────────────────────────────────────── */
  const DIFF_RULES = {
    normal: ["3 triplets to win","4-second card reveals","40-second turn timer","Bonus clue on any value double"],
    hard:   ["4 triplets to win","3-second card reveals","25-second turn timer","Bonus: new discoveries only","Memory decay after 3 rounds"],
  };

  function showWaitingRoom() {
    showOnly("waitingRoom");
    if ($("connStatus"))    $("connStatus").hidden    = false;
    if ($("lobbyChatWrap")) $("lobbyChatWrap").hidden = false;
    $("roomCodeDisplay").textContent = myRoomCode || "------";

    // Difficulty info
    const isHard = selectedDiff === "hard";
    const dl = $("waitingDiffLabel");
    dl.textContent = isHard ? "⚡ Hard" : "Normal";
    dl.className   = `diff-label ${selectedDiff}`;

    $("waitingDiffRules").innerHTML = (DIFF_RULES[selectedDiff] || DIFF_RULES.normal)
      .map(r => `<li>${r}</li>`).join("");

    $("startOnlineGame").hidden      = !isHost;
    $("waitingHint").textContent     = isHost
      ? "Press Start when everyone is seated."
      : "Waiting for the host to start…";

    renderWaitingList();
    updateStartBtn();
  }

  function renderWaitingList() {
    const list = $("waitingPlayerList");
    $("waitingCount").textContent = `${waitingPlayers.length} / 5`;
    $("waitingTitle").textContent = waitingPlayers.length < 2
      ? "Waiting for players…"
      : `${waitingPlayers.length} player${waitingPlayers.length > 1 ? "s" : ""} at the table`;

    list.innerHTML = waitingPlayers.map((p) => {
      const tags = [];
      if (p.isHost)             tags.push(`<span class="waiting-player-tag host-tag">HOST</span>`);
      if (p.id === myPlayerId)  tags.push(`<span class="waiting-player-tag you-tag">YOU</span>`);
      const dotClass = p.connected === false ? "offline" : "online";

      let hostControls = "";
      if (isHost && p.id !== myPlayerId) {
        hostControls = `<div class="host-controls" style="margin-left:auto;display:flex;gap:4px">
          <button class="host-ctrl-btn host-btn" data-action="makehost" data-player="${esc(p.id)}" type="button" title="Make Host">★</button>
          <button class="host-ctrl-btn kick-btn" data-action="kick" data-player="${esc(p.id)}" type="button" title="Kick player">✕</button>
        </div>`;
      }

      return `<li class="waiting-player">
        <span class="player-status-dot ${dotClass}"></span>
        <span class="waiting-player-name">${esc(p.name)}</span>
        ${tags.join("")}
        ${hostControls}
      </li>`;
    }).join("");
  }

  function updateStartBtn() {
    const canStart = waitingPlayers.length >= 3;
    $("startOnlineGame").disabled = !canStart;
    $("minPlayersHint").hidden    = canStart;
  }

  /* ─────────────────────────────────────────────────────────────
     Online Game — render
  ───────────────────────────────────────────────────────────── */
  function renderOnlineGame() {
    if (!onlineState) return;
    const st       = onlineState;
    const me       = st.players.find(p => p.id === myPlayerId);
    const current  = st.players.find(p => p.isCurrentPlayer);
    const isMyTurn = st.currentPlayerId === myPlayerId;
    const winner   = st.winnerId ? st.players.find(p => p.id === st.winnerId) : null;
    const sets2win = st.setsToWin || 3;
    const clues    = st.remainingClues ?? 0;

    // Header bar
    $("roundLabel").textContent = st.isFinished ? "Game complete" : `Round ${st.turnNumber}`;
    $("turnHeading").textContent = winner
      ? `${winner.name} wins!`
      : st.finishedReason ? "The deck is exhausted"
      : isMyTurn ? "Your turn"
      : `${current?.name || "…"}'s turn`;

    $("turnStatus").innerHTML = winner
      ? `<strong>${esc(winner.name)} takes the win!</strong><span>${winner.sets.includes(7) ? "The 7 triplet sealed it." : `Completed ${sets2win} triplets.`}</span>`
      : st.finishedReason
      ? `<strong>No winning triplet.</strong><span>${esc(st.finishedReason)}</span>`
      : isMyTurn
      ? `<strong>${clues} clue${clues !== 1 ? "s" : ""} remaining</strong><span>${st.turn.matrixFlipped ? "Free flip used." : "Free matrix flip available!"}</span>`
      : `<strong>Watching ${esc(current?.name || "…")}</strong><span>All reveals are public — memorize them.</span>`;

    renderOnlineScoreboard(st, sets2win);
    renderOnlineHand(st, me, isMyTurn);
    renderOnlineMatrix(st, isMyTurn);
    renderOnlineActions(st, isMyTurn);
    renderTimer(st);
  }

  function renderOnlineScoreboard(st, sets2win) {
    $("scoreboard").innerHTML = st.players.map(p => {
      const filled = p.sets.map(v => `<span class="set-dot filled">${esc(String(v))}</span>`).join("");
      const empty  = Array.from({ length: Math.max(0, sets2win - p.sets.length) }, () => '<span class="set-dot">·</span>').join("");
      return `<div class="player-chip ${p.isCurrentPlayer ? "current" : ""} ${p.penalized ? "penalized" : ""}">
        <span class="player-name">
          <span class="conn-dot-inline ${p.connected ? "connected" : "offline"}"></span>
          ${esc(p.name)}${p.isMe ? " <em>(you)</em>" : ""}
        </span>
        <div class="player-meta">
          <span>${p.handCount} card${p.handCount !== 1 ? "s" : ""}${p.penalized ? " · ⚠ skip" : ""}</span>
          <span class="set-dots" aria-label="${p.sets.length} triplets">${filled}${empty}</span>
        </div>
      </div>`;
    }).join("");
  }

  function renderOnlineHand(st, me, isMyTurn) {
    $("handHeading").textContent = me ? `${me.name}'s hand` : "Your hand";
    $("handCount").textContent   = me?.handCount ?? 0;
    $("handHint").textContent = st.isFinished
      ? "The game is over."
      : isMyTurn ? "Your private cards — only you can see these."
      : "Your hand is hidden until your turn.";

    const handEl = $("hand");
    if (isMyTurn && me?.hand?.length) {
      handEl.innerHTML = me.hand.map(cardMarkup).join("");
    } else if (isMyTurn && me?.hand?.length === 0) {
      handEl.innerHTML = '<p class="empty-state">No cards remain in your hand.</p>';
    } else {
      handEl.innerHTML = '<p class="quiet" style="margin:0;font-size:0.82rem">Visible on your turn.</p>';
    }
  }

  function renderOnlineMatrix(argSt, argMyTurn) {
    if (!onlineState) return;
    const st     = argSt     ?? onlineState;
    const myTurn = argMyTurn ?? (st.currentPlayerId === myPlayerId);
    const matrix = $("matrix");
    matrix.style.setProperty("--matrix-columns", st.configuration.columns);

    const freeLeft = myTurn && !st.turn.matrixFlipped;
    const noClues  = (st.remainingClues ?? 0) === 0 || st.isFinished;

    matrix.innerHTML = st.board.map(slot => {
      if (slot.isEmpty) return '<div class="matrix-card empty" aria-label="Claimed">claimed</div>';
      const n       = slot.slot;
      const preview = previewSlot === n;
      const seen    = st.turn.seenSlots.includes(n);
      const canAct  = myTurn && !st.isFinished && !isRevealActive();
      const dis     = !canAct || seen || (!freeLeft && noClues);
      const lbl     = preview ? `Matrix ${n + 1} revealed` : `Flip matrix ${n + 1}`;
      return `<button class="matrix-card${preview ? " preview" : ""}" data-slot="${n}" type="button" ${dis ? "disabled" : ""} aria-label="${lbl}">
        ${preview && activeReveal?.card ? cardMarkup(activeReveal.card) : '<span class="card-back" aria-hidden="true"></span>'}
      </button>`;
    }).join("");

    const hint = $("matrixFlipHint");
    if (myTurn) {
      hint.textContent = freeLeft ? "1 free flip left" : "Free flip used";
      hint.className   = `matrix-flip-hint ${freeLeft ? "free-flip-available" : "free-flip-used"}`;
    } else {
      hint.textContent = "Flip to reveal a card";
      hint.className   = "matrix-flip-hint";
    }
    $("matrixNote").textContent = previewSlot !== null
      ? "Memorize this card — it turns face down again soon."
      : freeLeft && myTurn
      ? "Use your free flip now, or save it and spend a clue later."
      : "Extra matrix flips cost a clue.";
  }

  function renderOnlineActions(argSt, argMyTurn) {
    if (!onlineState) return;
    const st     = argSt     ?? onlineState;
    const myTurn = argMyTurn ?? (st.currentPlayerId === myPlayerId);
    const clues  = st.remainingClues ?? 0;
    const cur    = st.players.find(p => p.isCurrentPlayer);

    $("clueCount").innerHTML = st.isFinished
      ? "The game is complete."
      : myTurn
      ? `<span>${clues}</span> of ${st.turn.maxActions} clue${st.turn.maxActions !== 1 ? "s" : ""} available`
      : `Watching ${esc(cur?.name || "…")}`;

    const noClues  = !myTurn || clues === 0 || st.isFinished || isRevealActive();
    $("askList").innerHTML = st.players
      .filter(p => !p.isMe && p.handCount > 0)
      .map(p => `
        <div class="ask-row">
          <span class="ask-name">${esc(p.name)} <em>(${p.handCount})</em></span>
          <button class="ask-button high" data-ask="highest" data-player="${p.id}" type="button" ${(noClues || p.highSeen) ? "disabled" : ""}>High</button>
          <button class="ask-button low"  data-ask="lowest"  data-player="${p.id}" type="button" ${(noClues || p.lowSeen)  ? "disabled" : ""}>Low</button>
        </div>`)
      .join("") || '<p class="empty-state">No opponents with cards.</p>';

    const sel = $("tripletValue");
    if (myTurn && Array.isArray(st.readyTriplets)) {
      sel.innerHTML = `<option value="" selected disabled>Choose a value</option>${
        VALUES.map(v => {
          const sv = String(v);
          const ok = st.readyTriplets.includes(sv);
          return `<option value="${esc(sv)}">${esc(sv)} × 3${ok ? " ✓" : ""}</option>`;
        }).join("")}`;
    } else {
      sel.innerHTML = '<option value="" selected disabled>Not your turn</option>';
    }

    const lock = isRevealActive();
    $("tripletValue").disabled = !myTurn || st.isFinished || lock;
    $("claimTriplet").disabled = !myTurn || st.isFinished || lock;

    const canEnd = myTurn && !st.isFinished && (st.turn.actions > 0 || st.turn.matrixFlipped) && !lock;
    $("endTurn").disabled    = !canEnd;
    $("endTurn").textContent = st.isFinished ? "Table complete" : "End turn";
  }

  function renderTimer(st) {
    const wrap = $("turnTimerWrap");
    if (!st || st.isFinished || !st.turnStartedAt) {
      wrap.hidden = true;
      stopTimer();
      return;
    }
    wrap.hidden = false;
    const duration   = st.difficulty === "hard" ? 25000 : 40000;
    const startedAt  = st.turnStartedAt;

    stopTimer();
    function tick() {
      const elapsed   = Date.now() - startedAt;
      const remaining = Math.max(0, duration - elapsed);
      const pct       = remaining / duration;

      $("turnTimerFill").style.width   = `${(pct * 100).toFixed(2)}%`;
      $("turnTimerLabel").textContent  = `${Math.ceil(remaining / 1000)}s`;

      const fill = $("turnTimerFill");
      fill.className = `turn-timer-fill${pct < 0.25 ? " danger" : pct < 0.5 ? " warning" : ""}`;

      if (remaining > 0) timerRaf = requestAnimationFrame(tick);
    }
    timerRaf = requestAnimationFrame(tick);
  }

  function stopTimer() {
    if (timerRaf) { cancelAnimationFrame(timerRaf); timerRaf = null; }
  }

  /* ─────────────────────────────────────────────────────────────
     Offline Game — render
  ───────────────────────────────────────────────────────────── */
  function renderOfflineGame() {
    if (!game) return;
    const cur    = game.currentPlayer;
    const winner = game.winnerId ? game.getPlayer(game.winnerId) : null;
    const clues  = game.getRemainingClues();

    $("roundLabel").textContent  = game.isFinished ? "Game complete" : `Round ${game.turnNumber}`;
    $("turnHeading").textContent = winner
      ? `${winner.name} wins!`
      : game.finishedReason ? "The deck is exhausted"
      : `${cur.name}'s turn`;

    $("turnStatus").innerHTML = winner
      ? `<strong>${esc(winner.name)} takes the win!</strong><span>${winner.sets.includes(7) ? "The 7 triplet sealed it." : "Completed 3 triplets."}</span>`
      : game.finishedReason
      ? `<strong>No winning triplet.</strong><span>${esc(game.finishedReason)}</span>`
      : `<strong>${clues} clue${clues !== 1 ? "s" : ""} remaining</strong><span>${game.turn.matrixFlipped ? "Free flip used." : "Free matrix flip available!"}</span>`;

    // Scoreboard
    $("scoreboard").innerHTML = game.players.map(p => {
      const filled = p.sets.map(v => `<span class="set-dot filled">${esc(String(v))}</span>`).join("");
      const empty  = Array.from({ length: Math.max(0, 3 - p.sets.length) }, () => '<span class="set-dot">·</span>').join("");
      return `<div class="player-chip ${p.id === game.currentPlayer.id ? "current" : ""} ${p.penalized ? "penalized" : ""}">
        <span class="player-name">${esc(p.name)}</span>
        <div class="player-meta">
          <span>${p.hand.length} card${p.hand.length !== 1 ? "s" : ""}${p.penalized ? " · ⚠ skip" : ""}</span>
          <span class="set-dots">${filled}${empty}</span>
        </div>
      </div>`;
    }).join("");

    renderOfflineHand();
    renderOfflineMatrix();
    renderOfflineActions();
  }

  function renderOfflineHand() {
    const p = game.currentPlayer;
    $("handHeading").textContent = `${p.name}'s sorted hand`;
    $("handCount").textContent   = p.hand.length;
    $("handHint").textContent    = game.isFinished
      ? "Review the final state."
      : "Pass the device when the next player is ready to look.";
    $("hand").innerHTML = game.getHand(p.id).map(cardMarkup).join("")
      || '<p class="empty-state">No cards remain in this hand.</p>';
  }

  function renderOfflineMatrix() {
    const matrix  = $("matrix");
    matrix.style.setProperty("--matrix-columns", game.configuration.columns);

    const freeLeft = !game.turn.matrixFlipped;
    const noClues  = game.getRemainingClues() === 0 || game.isFinished;

    matrix.innerHTML = game.board.map(slot => {
      if (!slot.cardId) return '<div class="matrix-card empty">claimed</div>';
      const n       = slot.slot;
      const preview = previewSlot === n;
      const seen    = game.turn.seenSlots.has(n);
      const card    = game.getCard(slot.cardId);
      const canAct  = !game.isFinished && !isRevealActive();
      const dis     = !canAct || seen || (!freeLeft && noClues);
      const lbl     = preview ? `Matrix ${n + 1} revealed` : `Flip matrix ${n + 1}`;
      return `<button class="matrix-card${preview ? " preview" : ""}" data-slot="${n}" type="button" ${dis ? "disabled" : ""} aria-label="${lbl}">
        ${preview ? cardMarkup(card) : '<span class="card-back" aria-hidden="true"></span>'}
      </button>`;
    }).join("");

    const hint = $("matrixFlipHint");
    hint.textContent = freeLeft ? "1 free flip left" : "Free flip used";
    hint.className   = `matrix-flip-hint ${freeLeft ? "free-flip-available" : "free-flip-used"}`;

    $("matrixNote").textContent = previewSlot !== null
      ? "Memorize this card — turns face down again soon."
      : freeLeft ? "Use your free flip: one free peek per turn."
      : "Extra matrix flips cost a clue.";
  }

  function renderOfflineActions() {
    const clues = game.getRemainingClues();
    const max   = game.turn.maxActions;

    $("clueCount").innerHTML = game.isFinished
      ? "The game is complete."
      : `<span>${clues}</span> of ${max} clue${max !== 1 ? "s" : ""} available`;

    const noClues = clues === 0 || game.isFinished || isRevealActive();
    $("askList").innerHTML = game.players
      .filter(p => p.id !== game.currentPlayer.id && p.hand.length > 0)
      .map(p => {
        const asked  = game.turn.askedPlayers.get(p.id) || new Set();
        const hiDis  = noClues || asked.has("highest");
        const loDis  = noClues || asked.has("lowest");
        return `<div class="ask-row">
          <span class="ask-name">${esc(p.name)} <em>(${p.hand.length})</em></span>
          <button class="ask-button high" data-ask="highest" data-player="${p.id}" type="button" ${hiDis ? "disabled" : ""}>High</button>
          <button class="ask-button low"  data-ask="lowest"  data-player="${p.id}" type="button" ${loDis ? "disabled" : ""}>Low</button>
        </div>`;
      }).join("") || '<p class="empty-state">No opponents with cards.</p>';

    $("tripletValue").innerHTML = `<option value="" selected disabled>Choose a value</option>${
      VALUES.map(v => `<option value="${esc(String(v))}">${esc(String(v))} × 3</option>`).join("")}`;

    const lock = isRevealActive();
    $("tripletValue").disabled = game.isFinished || lock;
    $("claimTriplet").disabled = game.isFinished || lock;

    const canEnd = !game.isFinished && (game.turn.actions > 0 || game.turn.matrixFlipped) && !lock;
    $("endTurn").disabled    = !canEnd;
    $("endTurn").textContent = game.isFinished ? "Table complete" : "End turn";
  }

  function safeOffline(fn) {
    try {
      fn();
    } catch (e) {
      showToast(e.message || "That move could not be completed.", true);
      renderOfflineGame();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     Offline Lobby
  ───────────────────────────────────────────────────────────── */
  function renderOfflineLobby() {
    $$('#countPicker').querySelectorAll("button").forEach(btn => {
      const sel = Number(btn.dataset.count) === selectedCount;
      btn.classList.toggle("selected", sel);
      btn.setAttribute("aria-pressed", String(sel));
    });
    const cfg = CONFIGURATIONS[selectedCount];
    $("dealSummary").textContent = `${cfg.handSize} cards per player · ${cfg.rows}×${cfg.columns} memory matrix`;
    $("nameFields").innerHTML = Array.from({ length: selectedCount }, (_, i) => `
      <label class="name-field">
        <span>${i + 1}</span>
        <input type="text" maxlength="18" data-name-index="${i}" value="Player ${i + 1}" aria-label="Name for player ${i + 1}" />
      </label>`).join("");
  }

  function startOfflineGame() {
    const names = [...$("nameFields").querySelectorAll("input")]
      .map((el, i) => el.value.trim() || `Player ${i + 1}`);
    game = new TripletGame({ playerNames: names, difficulty: "normal" });
    clearTimeout(revealTimer);
    previewSlot   = null;
    activeReveal  = null;
    $("revealPopup").hidden  = true;
    $("turnTimerWrap").hidden = true;
    $("difficultyBadge").hidden = true;
    $("connStatus").hidden   = true;
    showOnly("game");
    renderOfflineGame();
    showToast(`${game.currentPlayer.name} starts. Keep other hands private.`);
  }

  /* ─────────────────────────────────────────────────────────────
     Difficulty picker (online lobby)
  ───────────────────────────────────────────────────────────── */
  const DIFF_TAGS = {
    normal: ["3 triplets to win","4-second reveals","40-second turns","Bonus on any double"],
    hard:   ["4 triplets to win","3-second reveals","25-second turns","Bonus: new info only","Memory decay × 3 rounds"],
  };

  function updateDiffDesc(d) {
    $("diffDesc").innerHTML = (DIFF_TAGS[d] || DIFF_TAGS.normal).map(t => `<span>${t}</span>`).join("");
  }

  /* ─────────────────────────────────────────────────────────────
     Event listeners
  ───────────────────────────────────────────────────────────── */

  // ── Mode select ──
  $("goOnline").addEventListener("click", () => {
    mode = "online";
    $("connStatus").hidden = false;
    showOnly("onlineLobby");
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setConnStatus("reconnecting");
      connectWS();
    }
    // Pre-load room browser
    if (wsReady) sendWS({ type: "browse_rooms" });
  });

  // ── Quick Match button ──
  const qmBtn = $("quickMatch");
  if (qmBtn) {
    qmBtn.addEventListener("click", () => {
      const name = $("createName").value.trim() || "Player";
      if (!wsReady) { showToast("Connecting to server… try again.", true); return; }
      sendWS({ type: "quick_match", name, difficulty: selectedDiff });
    });
  }

  // ── Room browser: join from list ──
  const rbWrap = $("roomBrowserWrap");
  if (rbWrap) {
    rbWrap.addEventListener("click", e => {
      const btn = e.target.closest("[data-join-code]");
      if (!btn) return;
      const code = btn.dataset.joinCode;
      const name = $("joinName").value.trim() || $("createName").value.trim() || "Player";
      if (!wsReady) { showToast("Connecting…", true); return; }
      sendWS({ type: "join_room", name, code });
    });
    // Refresh room list button
    const refreshBtn = $("refreshRooms");
    if (refreshBtn) refreshBtn.addEventListener("click", () => { if (wsReady) sendWS({ type: "browse_rooms" }); });
  }

  $("goOffline").addEventListener("click", () => {
    mode = "offline";
    $("connStatus").hidden = true;
    showOnly("lobby");
    renderOfflineLobby();
  });

  $("backToMode").addEventListener("click", () => {
    mode = null;
    $("connStatus").hidden = true;
    showOnly("modeSelect");
  });

  $("brandHome").addEventListener("click", (e) => {
    e.preventDefault();
    if (!$("game").hidden) {
      const confirm = mode === "online"
        ? window.confirm("Leave the current game? You can rejoin within 60 seconds.")
        : true;
      if (confirm) {
        stopTimer();
        clearTimeout(revealTimer);
        previewSlot = null; activeReveal = null;
        $("revealPopup").hidden = true;
        mode = null;
        game = null;
        $("connStatus").hidden = true;
        showOnly("modeSelect");
      }
    }
  });

  // ── Online lobby: difficulty picker ──
  $("diffPicker").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-diff]");
    if (!btn) return;
    selectedDiff = btn.dataset.diff;
    $("diffPicker").querySelectorAll(".diff-btn").forEach(b => {
      const sel = b.dataset.diff === selectedDiff;
      b.classList.toggle("selected", sel);
      b.setAttribute("aria-pressed", String(sel));
    });
    updateDiffDesc(selectedDiff);
  });

  // ── Create room ──
  $("createRoom").addEventListener("click", () => {
    const name = $("createName").value.trim() || "Player";
    if (!wsReady) { showToast("Connecting to server… try again in a moment.", true); return; }
    sendWS({ type: "create_room", name, difficulty: selectedDiff });
  });
  $("createName").addEventListener("keydown", e => { if (e.key === "Enter") $("createRoom").click(); });

  // ── Join room ──
  $("joinRoom").addEventListener("click", () => {
    const name = $("joinName").value.trim() || "Player";
    const code = $("joinCode").value.trim().toUpperCase();
    if (code.length !== 6) { showToast("Enter a valid 6-character room code.", true); return; }
    if (!wsReady) { showToast("Connecting to server… try again in a moment.", true); return; }
    sendWS({ type: "join_room", name, code });
  });
  $("joinCode").addEventListener("input",  e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,""); });
  $("joinCode").addEventListener("keydown", e => { if (e.key === "Enter") $("joinRoom").click(); });

  // ── Waiting room ──
  $("startOnlineGame").addEventListener("click", () => sendWS({ type: "start_game" }));

  // ── Host controls: kick / transfer host ──
  $("waitingPlayerList").addEventListener("click", e => {
    const kickBtn     = e.target.closest("[data-kick]");
    const makeHostBtn = e.target.closest("[data-make-host]");
    if (kickBtn)     sendWS({ type: "kick_player",    targetId: kickBtn.dataset.kick });
    if (makeHostBtn) sendWS({ type: "transfer_host",  targetId: makeHostBtn.dataset.makeHost });
  });

  // ── Lobby chat ──
  const chatInput = $("lobbyChatInput");
  const chatSend  = $("lobbyChatSend");
  function sendChat() {
    if (!chatInput) return;
    const text = chatInput.value.trim();
    if (!text || !wsReady) return;
    sendWS({ type: "chat", text });
    chatInput.value = '';
  }
  if (chatSend)  chatSend.addEventListener("click", sendChat);
  if (chatInput) chatInput.addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

  $("leaveRoom").addEventListener("click", () => {
    if (ws) { ws.close(); ws = null; wsReady = false; }
    myPlayerId = null; myRoomCode = null; isHost = false;
    onlineState = null; waitingPlayers = [];
    stopTimer();
    mode = null;
    $("connStatus").hidden = true;
    showOnly("modeSelect");
  });

  $("copyCode").addEventListener("click", () => {
    if (!myRoomCode) return;
    navigator.clipboard.writeText(myRoomCode)
      .then(() => {
        $("copyLabel").textContent = "✓ Copied!";
        $("copyCode").classList.add("copied");
        setTimeout(() => { $("copyLabel").textContent = "⎘ Copy"; $("copyCode").classList.remove("copied"); }, 2200);
      })
      .catch(() => showToast("Code: " + myRoomCode, false));
  });

  // ── Offline lobby ──
  $("countPicker").addEventListener("click", e => {
    const btn = e.target.closest("[data-count]");
    if (!btn) return;
    selectedCount = Number(btn.dataset.count);
    renderOfflineLobby();
  });
  $("startGame").addEventListener("click", startOfflineGame);

  // ── New table (from game view) ──
  $("newGame").addEventListener("click", () => {
    stopTimer();
    clearTimeout(revealTimer);
    previewSlot = null; activeReveal = null;
    $("revealPopup").hidden = true;
    if (mode === "online") {
      if (ws) { ws.close(); ws = null; wsReady = false; }
      onlineState = null; myPlayerId = null; myRoomCode = null; waitingPlayers = [];
      mode = null;
      $("connStatus").hidden = true;
      showOnly("modeSelect");
    } else {
      game = null;
      mode = null;
      showOnly("modeSelect");
    }
  });

  // ── In-game actions ──
  $("game").addEventListener("click", e => {

    // Ask for high/low
    const askBtn = e.target.closest("[data-ask]");
    if (askBtn) {
      const targetId  = askBtn.dataset.player;
      const direction = askBtn.dataset.ask;
      if (mode === "online") {
        sendWS({ type: "ask", targetId, direction });
      } else {
        safeOffline(() => {
          const target = game.getPlayer(targetId);
          const result = game.ask(targetId, direction);
          beginTimedReveal({ title: `${target.name}'s ${direction} card`, card: result.card, duration: 4000 });
          if (result.bonus) showToast(`🎉 Bonus clue! ${game.currentPlayer.name} gets a 3rd clue this turn.`);
          else renderOfflineGame();
        });
      }
      return;
    }

    // Matrix flip
    const matBtn = e.target.closest("[data-slot]");
    if (matBtn) {
      const slot = Number(matBtn.dataset.slot);
      if (mode === "online") {
        sendWS({ type: "flip", slot });
      } else {
        safeOffline(() => {
          const result = game.flip(slot);
          beginTimedReveal({
            title:    `Matrix ${slot + 1}${result.free ? " (free flip)" : ""}`,
            card:     result.card,
            slot,
            duration: 4000,
          });
          if (result.bonus) showToast(`🎉 Bonus clue! ${game.currentPlayer.name} gets a 3rd clue.`);
          else renderOfflineGame();
        });
      }
      return;
    }

    // Claim triplet
    if (e.target.closest("#claimTriplet")) {
      const value = $("tripletValue").value;
      if (!value) { showToast("Select a triplet value first.", true); return; }
      if (mode === "online") {
        sendWS({ type: "claim_triplet", value });
      } else {
        safeOffline(() => {
          const result = game.claimTriplet(value);
          clearTimeout(revealTimer); previewSlot = null; activeReveal = null; $("revealPopup").hidden = true;
          renderOfflineGame();
          showToast(result.winner
            ? `🏆 ${result.winner.name} WINS!`
            : `✅ Triplet "${result.value}" claimed! Now ${game.currentPlayer.name}'s turn.`);
        });
      }
      return;
    }

    // End turn
    if (e.target.closest("#endTurn")) {
      if (mode === "online") {
        sendWS({ type: "end_turn" });
      } else {
        safeOffline(() => {
          const leaving = game.currentPlayer.name;
          game.endTurn();
          clearTimeout(revealTimer); previewSlot = null; activeReveal = null; $("revealPopup").hidden = true;
          renderOfflineGame();
          showToast(`${leaving} ended their turn. Pass device to ${game.currentPlayer.name}.`);
        });
      }
    }
  });

  // ── Rules dialog ──
  $("openRules").addEventListener("click", ()  => $("rulesDialog").showModal());
  $("closeRules").addEventListener("click", () => $("rulesDialog").close());

  /* ─────────────────────────────────────────────────────────────
     Init
  ───────────────────────────────────────────────────────────── */
  updateDiffDesc("normal");
  showOnly("modeSelect");

})();
