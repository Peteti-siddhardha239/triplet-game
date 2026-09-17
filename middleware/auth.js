/**
 * middleware/auth.js — JWT authentication + rate limiting middleware
 * Author: Peteti Siddhardha <sidhartha.peteti@gmail.com>
 */

"use strict";

require("dotenv").config();
const jwt = require("jsonwebtoken");
const db  = require("../db/database");

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "tt-access-secret";

/* ── In-memory rate limiter ────────────────────────────────────── */
const rateLimitStore = new Map(); // ip → { count, resetAt }

function rateLimit(maxRequests, windowMs) {
  return function rateLimitMiddleware(req, res, next) {
    const ip  = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let   entry = rateLimitStore.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(ip, entry);
    }

    entry.count++;
    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.writeHead(429, {
        "Content-Type":  "application/json",
        "Retry-After":   String(retryAfter),
      });
      return res.end(JSON.stringify({ error: "Too many requests. Please wait and try again.", retryAfter }));
    }

    next();
  };
}

/* ── JWT helpers ───────────────────────────────────────────────── */

/**
 * Express-style middleware. Reads Bearer token from Authorization header,
 * verifies it, checks session isn't revoked, and attaches req.user.
 */
function requireAuth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Authentication required." }));
  }

  let payload;
  try {
    payload = jwt.verify(token, ACCESS_SECRET);
  } catch {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Invalid or expired token." }));
  }

  // Check session not revoked
  const session = db.prepare(
    "SELECT revoked FROM sessions WHERE jti = ? AND expires_at > datetime('now')"
  ).get(payload.jti);

  if (!session || session.revoked) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Session expired. Please log in again." }));
  }

  // Attach user
  const user = db.prepare(
    "SELECT id, username, email, is_admin, is_verified, is_banned FROM users WHERE id = ?"
  ).get(payload.sub);

  if (!user || user.is_banned) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Account suspended." }));
  }

  req.user = user;
  next();
}

/**
 * Extends requireAuth — additionally checks is_admin flag.
 */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Admin access required." }));
    }
    next();
  });
}

// Purge stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, 5 * 60 * 1000);

module.exports = { requireAuth, requireAdmin, rateLimit };
