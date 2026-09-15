/**
 * Time Trotter Game Engine v2
 * Supports both browser (window.TimeTrotterEngine / window.TripletEngine) and Node.js (module.exports).
 *
 * DIFFICULTY CHANGES (v2):
 *  - Memory decay: knownCardIds "fade" after decayRounds full rounds
 *  - Hard mode: 4 triplets to win (normal: 3); 7-triplet instant win kept
 *  - Harder bonus clue: both clue cards must be genuinely new (not pre-known)
 *  - Free matrix flip: 1 per turn, doesn't cost a clue
 *  - Wrong-claim penalty state: player skips their next turn
 *  - _forceAdvanceTurn(): for server-side turn-timer expiry
 *  - Tracks seenSlots and askedPlayers for client-side UI disabling
 */
(function attachTimeTrotterEngine(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TimeTrotterEngine = api;
  root.TripletEngine = api; // Backwards compatibility alias
})(typeof globalThis !== "undefined" ? globalThis : this, function createTimeTrotterEngine() {
  "use strict";

  const VALUES = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, "+2", "+4"]);
  const COLOURS = Object.freeze(["red", "blue", "green"]);
  const CONFIGURATIONS = Object.freeze({
    3: Object.freeze({ handSize: 10, rows: 2, columns: 3 }),
    4: Object.freeze({ handSize: 8,  rows: 2, columns: 2 }),
    5: Object.freeze({ handSize: 6,  rows: 2, columns: 3 }),
  });

  /** Per-difficulty settings */
  const DIFFICULTY_CONFIG = Object.freeze({
    normal: Object.freeze({ setsToWin: 3, revealMs: 4000, decayRounds: 5, bonusRequiresNew: false, turnMs: 40000 }),
    hard:   Object.freeze({ setsToWin: 4, revealMs: 3000, decayRounds: 3, bonusRequiresNew: true,  turnMs: 25000 }),
  });

  const valueWeight = Object.freeze(
    VALUES.reduce((acc, v, i) => { acc[String(v)] = i; return acc; }, {}),
  );

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function normaliseValue(value) {
    return VALUES.find((c) => String(c) === String(value));
  }

  function createDeck() {
    return COLOURS.flatMap((colour) =>
      VALUES.map((value, vi) => ({ id: `${colour}-${vi}`, colour, value })),
    );
  }

  function shuffled(items, rng) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function cardLabel(card) {
    return `${card.value} ${card.colour}`;
  }

  class TimeTrotterGame {
    /**
     * @param {object} opts
     * @param {string[]} opts.playerNames   - Display names (3–5)
     * @param {string[]} [opts.playerIds]   - Optional custom IDs (for server)
     * @param {function} [opts.rng]         - RNG function (default Math.random)
     * @param {'normal'|'hard'} [opts.difficulty]
     */
    constructor({ playerNames, playerIds = null, rng = Math.random, difficulty = "normal" } = {}) {
      assert(Array.isArray(playerNames), "Add between three and five players to start.");
      assert(CONFIGURATIONS[playerNames.length], "Time Trotter supports three, four, or five players.");
      assert(typeof rng === "function", "The randomizer must be a function.");

      this.rng = rng;
      this.difficulty = DIFFICULTY_CONFIG[difficulty] ? difficulty : "normal";
      this.diffConfig = DIFFICULTY_CONFIG[this.difficulty];
      this.configuration = CONFIGURATIONS[playerNames.length];
      this.setsToWin = this.diffConfig.setsToWin;
      this.decayRounds = this.diffConfig.decayRounds;

      this.cards = createDeck();
      this.cardById = new Map(this.cards.map((c) => [c.id, c]));
      this.knownCardIds = new Set();
      this.removedCardIds = new Set();
      this.revealAge = new Map();   // cardId → turnNumber when last revealed
      this.events = [];
      this.turnNumber = 1;
      this.currentPlayerIndex = 0;
      this.winnerId = null;
      this.finishedReason = null;

      const deck = shuffled(this.cards.map((c) => c.id), this.rng);
      let cursor = 0;
      this.players = playerNames.map((rawName, index) => {
        const name = String(rawName || `Player ${index + 1}`).trim().slice(0, 18) || `Player ${index + 1}`;
        const id = (playerIds && playerIds[index]) ? playerIds[index] : `player-${index + 1}`;
        const hand = deck.slice(cursor, cursor + this.configuration.handSize);
        cursor += this.configuration.handSize;
        return { id, name, hand, sets: [], penalized: false };
      });

      this.board = deck.slice(cursor).map((cardId, slot) => ({ slot, cardId }));
      assert(
        this.board.length === this.configuration.rows * this.configuration.columns,
        "The deal does not match the selected table layout.",
      );

      this._startTurn();
      this._record({
        type: "system",
        message: `${this.players.length} players seated. ${this.configuration.handSize} cards each; ${this.board.length}-card matrix. Difficulty: ${this.difficulty}.`,
      });
    }

    /* ─────────── Getters ─────────── */

    get currentPlayer() {
      return this.players[this.currentPlayerIndex];
    }

    get isFinished() {
      return Boolean(this.winnerId || this.finishedReason);
    }

    /* ─────────── Lookups ─────────── */

    getCard(cardId) {
      const card = this.cardById.get(cardId);
      assert(card, "That card does not exist.");
      return card;
    }

    getPlayer(playerId) {
      const p = this.players.find((c) => c.id === playerId);
      assert(p, "That player is not at this table.");
      return p;
    }

    getBoardSlot(slot) {
      const s = this.board.find((c) => c.slot === Number(slot));
      assert(s, "That matrix position does not exist.");
      return s;
    }

    sortCardIds(cardIds) {
      return [...cardIds].sort((a, b) => {
        const ca = this.getCard(a);
        const cb = this.getCard(b);
        const dv = valueWeight[String(ca.value)] - valueWeight[String(cb.value)];
        if (dv !== 0) return dv;
        return COLOURS.indexOf(ca.colour) - COLOURS.indexOf(cb.colour);
      });
    }

    getHand(playerId) {
      return this.sortCardIds(this.getPlayer(playerId).hand).map((id) => this.getCard(id));
    }

    getRemainingClues() {
      return this.turn.maxActions - this.turn.actions;
    }

    /* ─────────── Core actions ─────────── */

    /**
     * Ask a player for their highest or lowest card.
     * Costs one clue.
     */
    ask(targetPlayerId, direction) {
      this._assertActionAvailable();
      assert(["highest", "lowest"].includes(direction), "Questions may only ask for the highest or lowest card.");
      assert(targetPlayerId !== this.currentPlayer.id, "Ask another player, not yourself.");

      const target = this.getPlayer(targetPlayerId);
      assert(target.hand.length > 0, `${target.name} has no cards left.`);

      const ordered = this.sortCardIds(target.hand);
      const cardId = direction === "highest" ? ordered[ordered.length - 1] : ordered[0];

      // Prevent asking the same direction from the same player twice in a turn
      const alreadyAsked = this.turn.askedPlayers.get(targetPlayerId);
      assert(!alreadyAsked?.has(direction), `You already asked ${target.name} for their ${direction} card this turn.`);

      const card = this.getCard(cardId);
      this.knownCardIds.add(cardId);
      this.revealAge.set(cardId, this.turnNumber);

      // Track ask
      if (!this.turn.askedPlayers.has(targetPlayerId)) this.turn.askedPlayers.set(targetPlayerId, new Set());
      this.turn.askedPlayers.get(targetPlayerId).add(direction);

      const matchesHand = this.currentPlayer.hand.some((ownId) => this.getCard(ownId).value === card.value);
      const result = this._consumeClue(cardId);
      const message = `${this.currentPlayer.name} asked ${target.name} for their ${direction} card: ${cardLabel(card)}.`;
      this._record({ type: "question", actorId: this.currentPlayer.id, targetId: target.id, direction, cardId, matchesHand, message });
      if (result.bonus) this._record({ type: "bonus", actorId: this.currentPlayer.id, message: `Bonus clue: duplicate new value ${card.value} discovered.` });
      return { card, matchesHand, ...result, message };
    }

    /**
     * Flip a matrix card.
     * First flip per turn is FREE (doesn't cost a clue).
     * Subsequent flips cost one clue each.
     */
    flip(slot) {
      assert(!this.isFinished, "The game is already over.");
      const isFreeFlip = !this.turn.matrixFlipped;

      // Free flip: no clue needed. Paid flip: need clues.
      if (!isFreeFlip) this._assertActionAvailable();

      const boardSlot = this.getBoardSlot(slot);
      assert(boardSlot.cardId, "That matrix position has already been claimed.");
      assert(!this.turn.seenSlots.has(boardSlot.slot), "That matrix card has already been flipped this turn.");

      const card = this.getCard(boardSlot.cardId);
      this.knownCardIds.add(boardSlot.cardId);
      this.revealAge.set(boardSlot.cardId, this.turnNumber);
      this.turn.seenSlots.add(boardSlot.slot);
      this.turn.seenCardIds.add(boardSlot.cardId);

      let result;
      if (isFreeFlip) {
        this.turn.matrixFlipped = true;
        result = { bonus: false, remainingClues: this.getRemainingClues(), free: true };
        this._record({ type: "flip", actorId: this.currentPlayer.id, slot: boardSlot.slot, cardId: boardSlot.cardId, free: true, message: `${this.currentPlayer.name} used their free flip: matrix ${boardSlot.slot + 1} → ${cardLabel(card)}.` });
      } else {
        result = this._consumeClue(boardSlot.cardId);
        result.free = false;
        this._record({ type: "flip", actorId: this.currentPlayer.id, slot: boardSlot.slot, cardId: boardSlot.cardId, free: false, message: `${this.currentPlayer.name} flipped matrix ${boardSlot.slot + 1}: ${cardLabel(card)}.` });
      }

      if (result.bonus) this._record({ type: "bonus", actorId: this.currentPlayer.id, message: `Bonus clue: duplicate new value ${card.value} discovered.` });
      return { card, ...result, message: result.free ? `Free flip: ${cardLabel(card)}` : `Clue flip: ${cardLabel(card)}` };
    }

    /**
     * Returns VALUES the current player can legally claim as a triplet.
     * Includes memory-decay: cards known more than decayRounds×playerCount turns ago are stale.
     * If all 3 cards of a rank are located and fresh, any player who deduced them can claim.
     */
    readyTriplets() {
      const player = this.currentPlayer;
      const decayLimit = this.decayRounds * this.players.length;

      return VALUES.filter((value) => {
        const rankCards = this.cards.filter(
          (c) => c.value === value && !this.removedCardIds.has(c.id),
        );
        const allLocated = rankCards.length === 3 && rankCards.every((c) => {
          if (player.hand.includes(c.id)) return true; // Own cards: always known
          if (!this.knownCardIds.has(c.id)) return false;
          // Decay check: re-reveal required if stale
          const age = this.turnNumber - (this.revealAge.get(c.id) ?? 0);
          return age <= decayLimit;
        });
        return allLocated;
      });
    }

    /**
     * Claim a triplet. Validates server-side / engine-side.
     * If claim is invalid, penalizes current player, records event, and advances turn.
     */
    claimTriplet(rawValue) {
      assert(!this.isFinished, "The game is already over.");
      const value = normaliseValue(rawValue);
      assert(value !== undefined, "Choose a valid card value for the triplet.");

      if (!this.readyTriplets().includes(value)) {
        const offender = this.currentPlayer;
        offender.penalized = true;
        this._record({
          type: "penalty",
          actorId: offender.id,
          message: `${offender.name} called an invalid triplet (${value})! Next turn skipped.`,
        });
        this._advanceTurn();
        return { wrongCall: true, penalisedPlayer: offender, value, advanced: true };
      }

      const cardIds = this.cards
        .filter((c) => c.value === value && !this.removedCardIds.has(c.id))
        .map((c) => c.id);
      assert(cardIds.length === 3, "A triplet must contain exactly three cards.");

      for (const player of this.players) player.hand = player.hand.filter((id) => !cardIds.includes(id));
      for (const slot of this.board) { if (cardIds.includes(slot.cardId)) slot.cardId = null; }
      cardIds.forEach((id) => { this.removedCardIds.add(id); this.knownCardIds.delete(id); this.revealAge.delete(id); });
      this.currentPlayer.sets.push(value);

      const claimedBy = this.currentPlayer;
      const winBy7   = value === 7;
      const winBySets = claimedBy.sets.length >= this.setsToWin;

      this._record({ type: "triplet", actorId: claimedBy.id, value, message: `${claimedBy.name} completed the ${value} triplet.` });

      if (winBy7 || winBySets) {
        this.winnerId = claimedBy.id;
        this._record({ type: "win", actorId: claimedBy.id, message: winBy7 ? `${claimedBy.name} wins with the 7 triplet!` : `${claimedBy.name} wins with ${this.setsToWin} triplets!` });
        return { winner: claimedBy, value, advanced: false };
      }

      this._advanceTurn();
      return { winner: null, value, advanced: true };
    }

    /** End the current player's turn voluntarily. Must have used ≥1 clue. */
    endTurn() {
      assert(!this.isFinished, "The game is already over.");
      assert(this.turn.actions > 0 || this.turn.matrixFlipped, "Use at least one clue or flip before ending the turn.");
      this._record({ type: "turnEnd", actorId: this.currentPlayer.id, message: `${this.currentPlayer.name} ends their turn.` });
      this._advanceTurn();
    }

    /** Force-advance the turn (called by the server when the timer expires). */
    _forceAdvanceTurn() {
      assert(!this.isFinished, "The game is already over.");
      this._record({ type: "turnForced", actorId: this.currentPlayer.id, message: `${this.currentPlayer.name}'s turn expired (time limit).` });
      this._advanceTurn();
    }

    /* ─────────── Private helpers ─────────── */

    _consumeClue(cardId) {
      const card = this.getCard(cardId);
      this.turn.actions += 1;
      this.turn.ranks.push(card.value);
      this.turn.seenCardIds.add(cardId);
      this.turn.clueCardIds.push(cardId);

      let bonus = false;
      if (this.turn.actions === 2 && this.turn.ranks[0] === this.turn.ranks[1]) {
        // Hard mode: bonus only if both clues revealed genuinely NEW information
        const bothNew = this.diffConfig.bonusRequiresNew
          ? this.turn.clueCardIds.slice(0, 2).every((id) => !this.turn.knownAtTurnStart.has(id))
          : true;
        if (bothNew) {
          this.turn.maxActions = 3;
          bonus = true;
        }
      }
      return { bonus, remainingClues: this.getRemainingClues() };
    }

    _assertActionAvailable() {
      assert(!this.isFinished, "The game is already over.");
      assert(this.getRemainingClues() > 0, "All clues for this turn have been used. End the turn or call a ready triplet.");
    }

    _startTurn() {
      this.turn = {
        actions: 0,
        maxActions: 2,
        ranks: [],
        seenCardIds: new Set(),
        seenSlots: new Set(),              // matrix slots flipped this turn
        askedPlayers: new Map(),           // playerId → Set<'highest'|'lowest'>
        knownAtTurnStart: new Set(this.knownCardIds), // snapshot for bonus rule
        matrixFlipped: false,
        clueCardIds: [],
      };
    }

    _advanceTurn() {
      if (this.players.every((p) => p.hand.length === 0)) {
        this.finishedReason = "All cards were claimed before a winning condition was met.";
        return;
      }

      const total = this.players.length;
      let nextIndex = this.currentPlayerIndex;
      let attempts = 0;

      while (attempts < total * 3) {
        nextIndex = (nextIndex + 1) % total;
        if (nextIndex === 0) this.turnNumber += 1;
        attempts++;

        const candidate = this.players[nextIndex];
        if (candidate.hand.length === 0) continue;

        if (candidate.penalized) {
          candidate.penalized = false;
          this._record({ type: "penalty_skip", actorId: candidate.id, message: `${candidate.name} loses a turn (wrong triplet call penalty).` });
          continue;
        }

        this.currentPlayerIndex = nextIndex;
        this._startTurn();
        return;
      }

      // Fallback: everyone penalized or empty
      this.finishedReason = "No eligible player found to continue.";
    }

    _record(event) {
      this.events.push({ index: this.events.length + 1, ...event });
    }
  }

  const TripletGame = TimeTrotterGame; // Alias for backwards compatibility

  return Object.freeze({
    VALUES,
    COLOURS,
    CONFIGURATIONS,
    DIFFICULTY_CONFIG,
    TimeTrotterGame,
    TripletGame,
    cardLabel,
    valueWeight,
    normaliseValue,
  });
});

