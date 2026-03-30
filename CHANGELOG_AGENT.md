# Agent Handoff Changelog

This file records AI-assisted project context, decisions, code changes, known bugs, and next steps for future sessions working on `roster-app`.

## Current Status

`roster-app` is an NHL Legacy league manager with a single-page frontend (`app.js`), a Flask + SQLite backend (`server/`), and a Discord bot (`bot/`).

The current intended direction is:
- NHL API is the source of player/roster data
- `players_ovr_plt_all.txt` and `players_ovr_plt_goalies.txt` are used to apply OVR/PLT ratings
- `SYS-DATA` should be kept only as a downloadable uploaded file for league members
- old `SYS-DATA` parsing logic has been removed from active app behavior

## Recent Decisions

### 2026-03-29
- Keep a persistent handoff log in the repo root for future AI sessions
- Keep `SYS-DATA` only for file upload/store/download distribution
- Remove `SYS-DATA` parsing logic from the app when implementation begins
- Preserve the NHL API + ratings text-file workflow

### 2026-03-29 — Implemented SYS-DATA distribution-only cleanup
- Updated `app.js` so SYS-DATA upload/download/remove is server-backed and metadata-only
- Removed frontend reliance on embedded `sysDataFile.data` blobs for downloads
- Removed parser-era `SYS-DATA` extraction from `server/routes/state.py`
- Normalized SYS-DATA metadata in `server/routes/sysdata.py` to include both `name` and `filename`
- Kept the NHL API roster refresh and OVR/PLT ratings workflow unchanged

## Architecture Notes

- **Frontend**
  - `index.html` is a shell with section containers
  - `app.js` contains the main SPA logic and large shared `state` object
  - `styles.css` contains app styling

- **Backend**
  - `run.py` launches the Flask server on port `3000`
  - `server/server.py` serves static files and `/api/*` routes
  - `server/db.py` initializes SQLite tables for `league_state`, `sysdata_file`, and `pending_requests`
  - `server/routes/state.py` stores the main league state JSON blob
  - `server/routes/sysdata.py` handles raw `SYS-DATA` upload/download/delete
  - `server/routes/pending.py` handles Discord approval queue
  - `server/routes/games.py` handles public team list and bot score submission
  - `server/routes/auth.py` handles admin JWT authentication

- **Bot**
  - `bot/bot.py` loads slash command extensions
  - `bot/api.py` wraps Flask API calls
  - `bot/commands/score.py`, `trade.py`, `pending.py`, `standings.py` implement Discord commands
  - `server/botmanager.py` starts/stops the bot process from the web app

## Read-Only Findings So Far

### Confirmed or likely bugs

- **Bot pending list auth mismatch**
  - `bot/commands/pending.py` calls `api_get('/api/pending?status=pending')`
  - `bot/api.py` `api_get()` has no token support
  - `GET /api/pending` requires admin auth
  - Likely result: `/pending` stays unauthorized even after `/botlogin`

- **Bot approve/reject trust boundary is weak**
  - `bot/commands/score.py` and `trade.py` approve/reject pending items through bot calls without passing an admin JWT
  - `PATCH /api/pending/<id>` accepts either bot secret or admin JWT
  - This may allow Discord-role-based approval without the same server-side admin token requirement as the website

- **Frontend/server `SYS-DATA` contract mismatch**
  - frontend code assumes `state.sysDataFile.data` exists for download
  - server strips the binary blob and keeps metadata only
  - field naming differs between `name` and `filename`
  - likely effect: broken download behavior or blank file labels after reload

- **Bot standings may use the wrong state shape**
  - `bot/commands/standings.py` reads `state.get('teams', [])`
  - main app state appears centered on `games`, `teamOwners`, and static team mappings
  - likely effect: degraded names or conference filtering in Discord standings

## SYS-DATA Removal Direction

The agreed implementation target is:
- keep `SYS-DATA` raw file distribution
- remove `SYS-DATA` parsing engine and parser-driven player extraction
- remove parser-era frontend assumptions about embedded base64 state blobs
- keep server-backed upload/download for the raw file
- keep NHL API roster refresh and ratings matching untouched

## Changes Made

### 2026-03-29 — SYS-DATA distribution-only implementation

- **Files changed**
  - `roster-app/app.js`
  - `roster-app/server/routes/state.py`
  - `roster-app/server/routes/sysdata.py`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Removed active frontend parsing behavior tied to SYS-DATA roster extraction
  - Switched dashboard/settings SYS-DATA downloads to `GET /api/sysdata`
  - Switched admin SYS-DATA uploads/removals to dedicated server routes instead of state-embedded blobs
  - Added metadata normalization so frontend state treats `sysDataFile` as metadata-only
  - Removed obsolete `/api/state` base64 SYS-DATA extraction path

- **Why**
  - The project now uses NHL API roster data plus the ratings text files, so SYS-DATA parsing was obsolete and risky
  - Keeping SYS-DATA as raw file distribution only is simpler and avoids frontend/server contract drift

- **Known follow-up**
  - Verify upload/download/remove flows manually in the browser
  - Fix the bot pending auth mismatch noted below

## Next Recommended Steps

1. Verify SYS-DATA upload/download/remove in the browser
2. Fix bot auth mismatch around `/pending`
3. Review bot approval auth boundary for score/trade approvals
4. Check Discord standings state-shape assumptions
5. Re-test player refresh and ratings import workflow after the SYS-DATA cleanup

## Update Rule For Future Sessions

For every meaningful session, add a short dated entry with:
- files changed
- what changed
- why it changed
- any known follow-up work
