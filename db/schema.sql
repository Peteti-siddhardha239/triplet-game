-- ============================================================
--  Time Trotter — SQLite schema  (v1.0)
--  Author: Jagadeesh <chjagadeesh.gdvl@gmail.com>
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Users ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT    UNIQUE NOT NULL,
  email            TEXT    UNIQUE NOT NULL,
  phone            TEXT    UNIQUE,
  password_hash    TEXT    NOT NULL,
  is_verified      INTEGER NOT NULL DEFAULT 0,
  is_admin         INTEGER NOT NULL DEFAULT 0,
  is_banned        INTEGER NOT NULL DEFAULT 0,
  ban_reason       TEXT,
  avatar_url       TEXT,
  bio              TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login       TEXT,
  login_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until     TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ── OTP tokens ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT    NOT NULL,
  purpose    TEXT    NOT NULL,   -- 'verify_email' | 'reset_password' | 'login_otp'
  expires_at TEXT    NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_otp_user ON otp_tokens(user_id, purpose);

-- ── Sessions (for JWT revocation) ─────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  jti        TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);

-- ── Player ELO ratings ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS player_ratings (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  elo              INTEGER NOT NULL DEFAULT 1200,
  wins             INTEGER NOT NULL DEFAULT 0,
  losses           INTEGER NOT NULL DEFAULT 0,
  draws            INTEGER NOT NULL DEFAULT 0,
  games_played     INTEGER NOT NULL DEFAULT 0,
  triplets_claimed INTEGER NOT NULL DEFAULT 0,
  perfect_turns    INTEGER NOT NULL DEFAULT 0,
  win_streak       INTEGER NOT NULL DEFAULT 0,
  best_streak      INTEGER NOT NULL DEFAULT 0,
  season           INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Match history ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code        TEXT,
  winner_id        INTEGER REFERENCES users(id),
  played_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  player_count     INTEGER NOT NULL,
  difficulty       TEXT    NOT NULL DEFAULT 'normal',
  duration_seconds INTEGER
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  elo_before INTEGER NOT NULL,
  elo_after  INTEGER NOT NULL,
  triplets   INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL   -- 1=winner, 2=runner-up, etc.
);

CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id);

-- ── Announcements (admin broadcasts) ──────────────────────────
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id  INTEGER REFERENCES users(id),
  message    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);
