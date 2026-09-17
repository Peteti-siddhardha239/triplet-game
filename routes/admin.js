/**
 * routes/admin.js — Admin REST API (requires is_admin = 1)
 * Author: Peteti Siddhardha <sidhartha.peteti@gmail.com>
 *
 * GET   /api/admin/users              — List all users
 * GET   /api/admin/users/:id          — User detail
 * PATCH /api/admin/users/:id          — Ban/unban, reset password, change role
 * DELETE /api/admin/users/:id         — Delete user
 * GET   /api/admin/stats              — Extended server stats
 * POST  /api/admin/announce           — Broadcast announcement (via WS broadcast fn)
 */

"use strict";

require("dotenv").config();
const bcrypt = require("bcryptjs");
const db     = require("../db/database");
const { requireAdmin } = require("../middleware/auth");

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end",  () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

// Injected from server.js so admin can broadcast over WS
let _broadcastFn = null;
function setBroadcastFn(fn) { _broadcastFn = fn; }

function handleAdmin(req, res, pathname) {
  const method = req.method.toUpperCase();

  /* ── GET /api/admin/users ──────────────────────────────────── */
  if (method === "GET" && pathname === "/api/admin/users") {
    return new Promise(resolve => requireAdmin(req, res, () => {
      const url    = new URL(req.url, "http://localhost");
      const page   = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const limit  = Math.min(100, parseInt(url.searchParams.get("limit") || "25", 10));
      const search = url.searchParams.get("q") || "";
      const offset = (page - 1) * limit;

      const users = db.prepare(`
        SELECT u.id, u.username, u.email, u.is_verified, u.is_admin, u.is_banned,
               u.ban_reason, u.created_at, u.last_login, u.login_attempts,
               pr.elo, pr.games_played, pr.wins
        FROM users u
        LEFT JOIN player_ratings pr ON pr.user_id = u.id
        WHERE u.username LIKE ? OR u.email LIKE ?
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?
      `).all(`%${search}%`, `%${search}%`, limit, offset);

      const total = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE username LIKE ? OR email LIKE ?")
        .get(`%${search}%`, `%${search}%`).cnt;

      resolve(json(res, 200, { users, total, page, limit, totalPages: Math.ceil(total / limit) }));
    }));
  }

  /* ── GET /api/admin/users/:id ─────────────────────────────── */
  const userDetailMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (method === "GET" && userDetailMatch) {
    return new Promise(resolve => requireAdmin(req, res, () => {
      const userId = parseInt(userDetailMatch[1], 10);
      const user   = db.prepare(`
        SELECT u.*, pr.elo, pr.wins, pr.losses, pr.games_played, pr.win_streak
        FROM users u LEFT JOIN player_ratings pr ON pr.user_id = u.id
        WHERE u.id = ?
      `).get(userId);
      if (!user) return resolve(json(res, 404, { error: "User not found." }));

      const recentMatches = db.prepare(`
        SELECT m.id, m.played_at, m.difficulty, mp.position, mp.elo_before, mp.elo_after
        FROM match_players mp JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = ?
        ORDER BY m.played_at DESC LIMIT 10
      `).all(userId);

      resolve(json(res, 200, { ...user, password_hash: undefined, recentMatches }));
    }));
  }

  /* ── PATCH /api/admin/users/:id ───────────────────────────── */
  const userPatchMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (method === "PATCH" && userPatchMatch) {
    return new Promise(resolve => requireAdmin(req, res, async () => {
      const userId = parseInt(userPatchMatch[1], 10);
      const { action, reason, newPassword, is_admin } = await parseBody(req);

      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
      if (!user) return resolve(json(res, 404, { error: "User not found." }));
      if (user.id === req.user.id && action === "ban") return resolve(json(res, 400, { error: "Cannot ban yourself." }));

      switch (action) {
        case "ban":
          db.prepare("UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?").run(reason || "Policy violation", userId);
          // Revoke all sessions
          db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(userId);
          resolve(json(res, 200, { message: "User banned and sessions revoked." }));
          break;

        case "unban":
          db.prepare("UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?").run(userId);
          resolve(json(res, 200, { message: "User unbanned." }));
          break;

        case "reset_password":
          if (!newPassword || newPassword.length < 8) return resolve(json(res, 400, { error: "Password too short." }));
          const hash = await bcrypt.hash(newPassword, 12);
          db.prepare("UPDATE users SET password_hash = ?, login_attempts = 0, locked_until = NULL WHERE id = ?").run(hash, userId);
          db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(userId);
          resolve(json(res, 200, { message: "Password reset and sessions revoked." }));
          break;

        case "set_admin":
          if (is_admin === undefined) return resolve(json(res, 400, { error: "is_admin required." }));
          db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(is_admin ? 1 : 0, userId);
          resolve(json(res, 200, { message: `Admin status ${is_admin ? "granted" : "revoked"}.` }));
          break;

        case "unlock":
          db.prepare("UPDATE users SET login_attempts = 0, locked_until = NULL WHERE id = ?").run(userId);
          resolve(json(res, 200, { message: "Account unlocked." }));
          break;

        default:
          resolve(json(res, 400, { error: "Unknown action. Valid: ban | unban | reset_password | set_admin | unlock" }));
      }
    }));
  }

  /* ── DELETE /api/admin/users/:id ──────────────────────────── */
  const userDeleteMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (method === "DELETE" && userDeleteMatch) {
    return new Promise(resolve => requireAdmin(req, res, () => {
      const userId = parseInt(userDeleteMatch[1], 10);
      if (userId === req.user.id) return resolve(json(res, 400, { error: "Cannot delete your own account." }));
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      resolve(json(res, 200, { message: "User deleted." }));
    }));
  }

  /* ── GET /api/admin/stats ──────────────────────────────────── */
  if (method === "GET" && pathname === "/api/admin/stats") {
    return new Promise(resolve => requireAdmin(req, res, () => {
      const stats = {
        totalUsers:    db.prepare("SELECT COUNT(*) AS c FROM users").get().c,
        verifiedUsers: db.prepare("SELECT COUNT(*) AS c FROM users WHERE is_verified = 1").get().c,
        bannedUsers:   db.prepare("SELECT COUNT(*) AS c FROM users WHERE is_banned = 1").get().c,
        totalMatches:  db.prepare("SELECT COUNT(*) AS c FROM matches").get().c,
        totalSessions: db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE revoked = 0 AND expires_at > datetime('now')").get().c,
        newUsersToday: db.prepare("SELECT COUNT(*) AS c FROM users WHERE created_at >= date('now')").get().c,
        matchesToday:  db.prepare("SELECT COUNT(*) AS c FROM matches WHERE played_at >= date('now')").get().c,
      };
      resolve(json(res, 200, stats));
    }));
  }

  /* ── POST /api/admin/announce ──────────────────────────────── */
  if (method === "POST" && pathname === "/api/admin/announce") {
    return new Promise(resolve => requireAdmin(req, res, async () => {
      const { message, expiresIn } = await parseBody(req);
      if (!message || message.length < 1) return resolve(json(res, 400, { error: "Message required." }));

      const expiresAt = expiresIn
        ? new Date(Date.now() + expiresIn * 60 * 1000).toISOString().replace("T", " ").slice(0, 19)
        : null;

      db.prepare("INSERT INTO announcements (author_id, message, expires_at) VALUES (?, ?, ?)")
        .run(req.user.id, message, expiresAt);

      // Broadcast via WebSocket if available
      if (_broadcastFn) {
        _broadcastFn({ type: "announcement", message, expiresAt, author: req.user.username });
      }

      resolve(json(res, 200, { message: "Announcement sent to all connected players." }));
    }));
  }

  return null; // no match
}

module.exports = { handleAdmin, setBroadcastFn };
