-- NHL Legacy League - Database Schema Migrations
-- Run these in order to upgrade the database for multi-user robustness

-- ============================================================================
-- Migration 1: User Links Table
-- ============================================================================
-- Dedicated storage for Discord OAuth account links
-- Replaces storing discordId/zamboniTag directly in manager records

CREATE TABLE IF NOT EXISTS user_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL UNIQUE,
    manager_id TEXT NOT NULL,
    discord_username TEXT,
    discord_avatar TEXT,
    discord_global_name TEXT,
    zamboni_tag TEXT,
    linked_at TEXT NOT NULL,
    updated_at TEXT,
    last_active_at TEXT,
    source TEXT DEFAULT 'website' -- 'website', 'discord-bot', 'admin'
);

CREATE INDEX IF NOT EXISTS idx_user_links_discord ON user_links(discord_id);
CREATE INDEX IF NOT EXISTS idx_user_links_manager ON user_links(manager_id);
CREATE INDEX IF NOT EXISTS idx_user_links_active ON user_links(last_active_at);

-- ============================================================================
-- Migration 2: Score Submissions Table
-- ============================================================================
-- Dedicated storage for score submissions with full audit trail
-- Prevents conflicts from simultaneous submissions

CREATE TABLE IF NOT EXISTS score_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    submitted_by_discord_id TEXT NOT NULL,
    submitted_by_manager_id TEXT NOT NULL,
    home_score INTEGER NOT NULL,
    away_score INTEGER NOT NULL,
    ot BOOLEAN NOT NULL DEFAULT 0,
    zamboni_game_id TEXT,
    zamboni_stats TEXT, -- JSON blob
    source TEXT NOT NULL, -- 'website', 'discord-bot', 'admin'
    submitted_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'superseded'
    approved_by TEXT,
    approved_at TEXT,
    rejection_reason TEXT,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_score_game ON score_submissions(game_id);
CREATE INDEX IF NOT EXISTS idx_score_submitter_discord ON score_submissions(submitted_by_discord_id);
CREATE INDEX IF NOT EXISTS idx_score_submitter_manager ON score_submissions(submitted_by_manager_id);
CREATE INDEX IF NOT EXISTS idx_score_status ON score_submissions(status);
CREATE INDEX IF NOT EXISTS idx_score_submitted_at ON score_submissions(submitted_at);

-- ============================================================================
-- Migration 3: Trade Offers Table (future)
-- ============================================================================
-- Placeholder for future trade offer system

CREATE TABLE IF NOT EXISTS trade_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_manager_id TEXT NOT NULL,
    to_manager_id TEXT NOT NULL,
    from_team_code TEXT NOT NULL,
    to_team_code TEXT NOT NULL,
    players_offered TEXT NOT NULL, -- JSON array
    players_requested TEXT NOT NULL, -- JSON array
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending_partner', -- 'pending_partner', 'accepted_pending_admin', 'rejected', 'cancelled', 'approved', 'completed'
    created_at TEXT NOT NULL,
    updated_at TEXT,
    partner_responded_at TEXT,
    admin_reviewed_by TEXT,
    admin_reviewed_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_trade_from ON trade_offers(from_manager_id);
CREATE INDEX IF NOT EXISTS idx_trade_to ON trade_offers(to_manager_id);
CREATE INDEX IF NOT EXISTS idx_trade_status ON trade_offers(status);
CREATE INDEX IF NOT EXISTS idx_trade_created ON trade_offers(created_at);

-- ============================================================================
-- Migration 4: Bot Events Queue
-- ============================================================================
-- Queue used by the Discord bot to post league updates (scores, trades, etc.)

CREATE TABLE IF NOT EXISTS bot_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    handled_at TEXT,
    handled_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_bot_events_pending ON bot_events(handled_at);
