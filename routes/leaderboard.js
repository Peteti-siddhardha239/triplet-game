/**
 * routes/leaderboard.js — Leaderboard REST API
 * Author: Peteti Siddhardha <sidhartha.peteti@gmail.com>
 *
 * GET  /api/leaderboard           — Top 100 players (paginated)
 * GET  /api/leaderboard/me        — Current user rank + stats
 * GET  /api/leaderboard/history   — Recent match history
 * GET  /api/leaderboard/seasons   — Available seasons
 */

"use strict";

const db  = require("../db/database");
const { requireAuth } = require("../middleware/auth");
const { getRankTier, winRate } = require("../lib/elo");

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control":  "public, max-age=10", // 10-second leaderboard cache
  });
  res.end(payload);
}

function handleLeaderboard(req, res, pathname) {
  const url    = new URL(req.url, "http://localhost");
  const method = req.method.toUpperCase();

  /* ── GET /api/leaderboard ──────────────────────────────────── */
  if (method === "GET" && pathname === "/api/leaderboard") {
    const page   = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit  = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));
    const season = url.searchParams.get("season") || null;
    const search = url.searchParams.get("q") || "";
    const offset = (page - 1) * limit;

    const whereClause = season
      ? "WHERE pr.season = ? AND u.username LIKE ?"
      : "WHERE u.username LIKE ?";
    const params = season
      ? [season, `%${search}%`, limit, offset]
      : [`%${search}%`, limit, offset];

    const rows = db.prepare(`
      SELECT
        u.id, u.username, u.avatar_url,
        pr.elo, pr.wins, pr.losses, pr.draws, pr.games_played,
        pr.triplets_claimed, pr.win_streak, pr.best_streak,
        pr.season,
        ROW_NUMBER() OVER (ORDER BY pr.elo DESC) AS rank
      FROM player_ratings pr
      JOIN users u ON u.id = pr.user_id
      ${whereClause}
      ORDER BY pr.elo DESC
      LIMIT ? OFFSET ?
    `).all(...params);

    const total = db.prepare(`
      SELECT COUNT(*) AS cnt FROM player_ratings pr
      JOIN users u ON u.id = pr.user_id
      ${whereClause}
    `).get(...(season ? [season, `%${search}%`] : [`%${search}%`])).cnt;

    const enriched = rows.map(r => ({
      ...r,
      winRate:  winRate(r.wins, r.games_played),
      tier:     getRankTier(r.elo),
    }));

    return json(res, 200, {
      players: enriched,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  }

  /* ── GET /api/leaderboard/me ───────────────────────────────── */
  if (method === "GET" && pathname === "/api/leaderboard/me") {
    return new Promise(resolve => requireAuth(req, res, () => {
      const userId = req.user.id;

      const rating = db.prepare(`
        SELECT
          pr.*,
          (SELECT COUNT(*) + 1 FROM player_ratings pr2 WHERE pr2.elo > pr.elo) AS rank
        FROM player_ratings pr WHERE pr.user_id = ?
      `).get(userId);

      if (!rating) return resolve(json(res, 404, { error: "Rating not found." }));

      // Recent 5 matches
      const recentMatches = db.prepare(`
        SELECT m.id, m.played_at, m.difficulty, m.player_count,
               mp.position, mp.elo_before, mp.elo_after,
               (mp.elo_after - mp.elo_before) AS elo_delta,
               u_winner.username AS winner_username
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id
        LEFT JOIN users u_winner ON u_winner.id = m.winner_id
        WHERE mp.user_id = ?
        ORDER BY m.played_at DESC
        LIMIT 5
      `).all(userId);

      resolve(json(res, 200, {
        ...rating,
        winRate:       winRate(rating.wins, rating.games_played),
        tier:          getRankTier(rating.elo),
        recentMatches,
      }));
    }));
  }

  /* ── GET /api/leaderboard/history ─────────────────────────── */
  if (method === "GET" && pathname === "/api/leaderboard/history") {
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "20", 10));

    const matches = db.prepare(`
      SELECT
        m.id, m.room_code, m.played_at, m.player_count, m.difficulty, m.duration_seconds,
        u.username AS winner_username, u.avatar_url AS winner_avatar
      FROM matches m
      LEFT JOIN users u ON u.id = m.winner_id
      ORDER BY m.played_at DESC
      LIMIT ?
    `).all(limit);

    // Attach player list for each match
    const enriched = matches.map(match => {
      const players = db.prepare(`
        SELECT u.username, u.avatar_url, mp.position, mp.elo_before, mp.elo_after, mp.triplets
        FROM match_players mp JOIN users u ON u.id = mp.user_id
        WHERE mp.match_id = ?
        ORDER BY mp.position
      `).all(match.id);
      return { ...match, players };
    });

    return json(res, 200, { matches: enriched });
  }

  return null; // no match
}

module.exports = { handleLeaderboard };
