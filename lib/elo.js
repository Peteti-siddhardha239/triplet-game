/**
 * lib/elo.js — ELO rating calculator (multi-player)
 * Author: Peteti Siddhardha <sidhartha.peteti@gmail.com>
 *
 * Standard ELO with multi-player extension:
 *   Expected score = 1 / (1 + 10^((opp_elo - player_elo) / 400))
 *   Delta          = K * (actual - expected)
 *   Multi-player   = average delta vs all opponents
 *
 * Bonuses:
 *   +5  per perfect turn (bonus guess earned) — skill expression bonus
 *   +10 win streak bonus at 3, 5, 10+ streak
 */

"use strict";

const K_FACTOR = 32;

/**
 * Compute new ELO ratings for all players in a completed match.
 *
 * @param {Array<{ userId: number, elo: number, position: number, perfectTurns: number, winStreak: number }>} players
 *   Sorted by position (1 = winner, 2 = 2nd, …)
 * @returns {Array<{ userId: number, eloAfter: number, delta: number }>}
 */
function computeEloDeltas(players) {
  const n = players.length;
  if (n < 2) return players.map(p => ({ userId: p.userId, eloAfter: p.elo, delta: 0 }));

  const results = players.map(player => {
    let totalExpected = 0;
    let totalActual   = 0;

    players.forEach(opponent => {
      if (opponent.userId === player.userId) return;

      // Expected probability of winning against this opponent
      const expected = 1 / (1 + Math.pow(10, (opponent.elo - player.elo) / 400));
      totalExpected += expected;

      // Actual score: 1 = beat them, 0.5 = tie position, 0 = lost to them
      const actual = player.position < opponent.position ? 1
                   : player.position === opponent.position ? 0.5
                   : 0;
      totalActual += actual;
    });

    // Average delta across all opponents
    const opponents = n - 1;
    const delta = K_FACTOR * ((totalActual / opponents) - (totalExpected / opponents));

    // Skill bonuses
    let bonus = 0;
    if (player.perfectTurns >= 2) bonus += 5;              // bonus-guess-earner reward
    if (player.position === 1 && player.winStreak >= 10)   bonus += 10;
    else if (player.position === 1 && player.winStreak >= 5) bonus += 6;
    else if (player.position === 1 && player.winStreak >= 3) bonus += 3;

    const eloAfter = Math.max(100, Math.round(player.elo + delta + bonus));

    return {
      userId:   player.userId,
      eloAfter,
      delta:    eloAfter - player.elo,
    };
  });

  return results;
}

/**
 * Get rank tier label + colour from ELO
 */
function getRankTier(elo) {
  if (elo >= 2400) return { label: "Grand Master", color: "#ff6b35", icon: "👑" };
  if (elo >= 2000) return { label: "Master",       color: "#a855f7", icon: "🔮" };
  if (elo >= 1800) return { label: "Diamond",      color: "#38bdf8", icon: "💎" };
  if (elo >= 1600) return { label: "Platinum",     color: "#34d399", icon: "🏆" };
  if (elo >= 1400) return { label: "Gold",         color: "#fbbf24", icon: "⭐" };
  if (elo >= 1200) return { label: "Silver",       color: "#94a3b8", icon: "🥈" };
  return                   { label: "Bronze",      color: "#b45309", icon: "🥉" };
}

/**
 * Win-rate as a percentage string
 */
function winRate(wins, gamesPlayed) {
  if (!gamesPlayed) return "0%";
  return `${Math.round((wins / gamesPlayed) * 100)}%`;
}

module.exports = { computeEloDeltas, getRankTier, winRate };
