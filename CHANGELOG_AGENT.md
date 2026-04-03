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

### 2026-03-30 — Implemented admin/auth hardening on `dev`
- Updated `app.js` so admin UI depends on verified server auth instead of client-side hash checks
- Moved admin token storage from `localStorage` to `sessionStorage`
- Added `/api/auth/session` and `/api/auth/password` in `server/routes/auth.py`
- Replaced the legacy simple password-hash auth flow with `bcrypt` plus migration for existing stored hashes
- Added in-memory rate limiting for `/api/auth`
- Scoped CORS in `server/server.py` to configured origins via `NHL_CORS_ORIGINS` instead of wildcard global CORS
- Updated `server/routes/state.py` so normal state saves preserve the stored admin password hash instead of allowing browser overwrites
- Added `bcrypt` to `requirements.txt`

### 2026-03-30 — First-pass draft module extraction
- Added `draft.js` as a dedicated browser module for the active live draft flow
- Reduced `app.js` draft integration to a thinner wrapper/context layer for live draft actions
- Reworked the live draft UI structure around on-clock info, recent picks, round order, and available-player browsing
- Kept legacy imported/team-draft code in `app.js` for now, but moved the active live-draft behavior out of the main SPA file
- Updated `index.html` to load `draft.js` before `app.js`

### 2026-03-30 — Draft available-list UX follow-up
- Sorted available live-draft players by highest OVR first by default
- Added quick position filters for `All`, `F`, `D`, and `G`
- Preserved available-list search/filter state across draft rerenders
- Preserved the available-list scroll position when making picks so the list does not jump back unexpectedly

### 2026-03-30 — Draft page comfort/layout polish
- Promoted `Available Players` into the main sticky drafting workspace in the right column
- Added compact session summary pills for progress, pool size, filtered count, and on-clock manager
- Compressed recent picks and auto-draft into smaller supporting cards so the player pool gets more space
- Added a progress indicator and stronger visual hierarchy for the on-clock card

### 2026-03-30 — Draft room event/density pass
- Removed extra top-of-page chrome so the Draft tab gets to the action faster
- Slimmed the on-clock hero into a denser stage card with inline progress and pool stats
- Widened the available-player workspace and made player rows/headshots more compact
- Trimmed supporting cards so the page feels more like a live draft room than a dashboard

### 2026-03-30 — Draft queue + top-targets workflow
- Added right-panel modes for `Top Targets`, `Queue`, and `Full Pool`
- Added queue/watchlist toggles directly on player rows for shortlist building during the draft
- Fixed the draft search input so it no longer loses focus after each character
- Updated the right panel so filtering/searching rerenders in place instead of redrawing the whole Draft tab

### 2026-03-30 — Draft density refinement
- Further reduced card padding, row height, badge size, and helper text across the Draft tab
- Tightened support sections (`Recent`, `Auto-Draft`, `Order`, `Draft Board`) so more of the real drafting surface fits above the fold
- Kept the new `Top Targets`, `Queue`, and `Full Pool` workflow while making the overall page feel less oversized

### 2026-03-30 — Draft pick regression fix
- Restored `Pick` button behavior after the right-panel refactor moved player rows into an in-place updated panel
- Moved pick handling into shared draft module logic so both initial render and panel updates bind to the same action path

### 2026-03-30 — Draft room motion pass
- Added on-clock transition detection so the draft room animates when the next pick comes up
- Added a stage-card pulse/sheen effect plus right-panel and target-row entrance motion
- Kept the motion restrained so the page feels alive during transitions without becoming distracting during active drafting

### 2026-03-30 — Draft panel smoothness fix
- Replaced repeated right-panel listener rebinding with delegated click/scroll handlers
- Fixed sticky/janky interactions where position filter clicks could feel frozen or fail to highlight cleanly

### 2026-03-30 — Draft motion rollback
- Removed the draft-room motion/animation layer after it destabilized core button interactions
- Returned the Draft tab to the last stable pre-animation state so queue, filters, and picks work reliably again

### 2026-03-30 — Draft panel control restore
- Rewired the draft right-panel controls through the panel root after render so filter buttons and `Pick` actions attach reliably again
- Kept the queue/targets/full-pool workflow intact while restoring the functional click path

### 2026-03-30 — Draft filter active-state fix
- Re-rendered the bottom position filter chip row during panel updates so the active `All / F / D / G` highlight stays in sync with the current filter

### 2026-03-30 — Draft team-scoped queue selector
- Added a manager/team dropdown above the queue tools so the shortlist can be curated per team
- Changed queue storage from one shared list to team-specific queues keyed by manager

### 2026-03-30 — Queue-first auto draft
- Updated auto draft so it checks the on-clock manager's queue first before falling back to the existing best-available logic
- Auto draft skips queued players that are no longer available or do not satisfy the current roster-need constraints

### 2026-03-30 — Full draft board editing
- Updated the main Draft Board to render the full pick history instead of only the recent slice
- Kept every pick editable from the board so older mistakes can be fixed without losing access to earlier rounds

### 2026-03-30 — Settings safety pass
- Moved `Simulate Full Season` out of the normal settings flow and into an `Advanced Settings` danger area
- Kept the action available for testing while reducing the chance a non-technical admin triggers it accidentally

### 2026-03-30 — Settings cleanup pass
- Removed `Import Player Ratings` from Settings and its related auto-import plumbing
- Refined the managers/team assignment UI with clearer manager summaries and more scannable assignment cards

### 2026-03-31 — Mobile navigation fix
- Updated the small-screen layout so the main section nav becomes a horizontal, scrollable top strip instead of a cramped sidebar
- Increased mobile nav tap-target stability so non-dashboard sections remain reachable on phones

## Architecture Notes

- **Frontend**
  - `index.html` is a shell with section containers
  - `app.js` contains the main SPA logic and large shared `state` object
  - `styles.css` contains app styling

- **Backend**
  - `run.py` launches the Flask server on port `3001` (env `PORT` overrides)
  - `server/server.py` serves static files and `/api/*` routes
  - `server/db.py` initializes SQLite tables for `league_state`, `sysdata_file`, and `pending_requests`
  - `server/routes/state.py` stores the main league state JSON blob
  - `server/routes/sysdata.py` handles raw `SYS-DATA` upload/download/delete
  - `server/routes/pending.py` handles Discord approval queue
  - `server/routes/games.py` handles public team list (`GET /api/teams`) and bot score submission (`POST /api/bot/score`)
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

### 2026-03-30 — Admin/auth hardening

- **Files changed**
  - `roster-app/app.js`
  - `roster-app/server/routes/auth.py`
  - `roster-app/server/routes/state.py`
  - `roster-app/server/server.py`
  - `roster-app/requirements.txt`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Removed frontend-only admin elevation and server-verifies-first login behavior
  - Added server-backed session verification and password update endpoints
  - Migrated password handling toward `bcrypt` while accepting legacy stored hashes once for migration
  - Added `/api/auth` throttling to slow repeated login attempts
  - Preserved the stored admin password hash during `/api/state` saves
  - Restricted CORS to explicit configured origins rather than `*`

- **Why**
  - The previous auth model trusted browser state too much and exposed admin UI/actions to DevTools tampering
  - Password storage needed a real password hashing function rather than a client-compatible rolling hash
  - Production API exposure should not use broad wildcard CORS by default

- **Known follow-up**
  - Set `NHL_CORS_ORIGINS` in environments that need cross-origin API access
  - Install updated Python dependencies so `bcrypt` is available
  - Manually test admin login, logout, password change, and expired/invalid-token behavior in the browser
  - Consider tightening admin-only handlers further so failed `/api/state` saves surface clearly to the UI

### 2026-03-30 — Draft module refactor (first pass)

- **Files changed**
  - `roster-app/app.js`
  - `roster-app/draft.js`
  - `roster-app/index.html`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Extracted the active live draft behavior out of the large inlined `app.js` Draft section into a dedicated `draft.js` module
  - Added a module context bridge in `app.js` so draft code can use shared app state/helpers without owning the rest of the SPA
  - Reworked the live draft layout to better expose on-clock status, recent picks, round order, available players, and auto-draft controls
  - Centralized live-draft state derivation and pick mutation logic inside the draft module

- **Why**
  - The draft feature had become one of the most tightly coupled sections of `app.js`
  - Improving live draft UX and rules is much easier once draft calculations and mutations have a dedicated boundary

- **Known follow-up**
  - Manually test the Draft tab in the browser with realistic manager/player state and an active draft
  - Decide whether imported draft and team draft should also move into `draft.js` or be simplified/retired
  - Add better validation around duplicate draft-order positions and commissioner-style undo/reset behavior

### 2026-03-30 — Draft available-list UX follow-up

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Sorted the live draft available-player list by highest OVR first by default
  - Added position filter buttons for `All`, `F`, `D`, and `G`
  - Preserved search/filter UI state and scroll position across list rerenders after picks

- **Why**
  - The available-player list was jumping after each pick and made fast drafting frustrating
  - Drafting should keep the highest-rated players visible by default and make position-only browsing immediate

- **Known follow-up**
  - Verify the Draft tab behavior in-browser while making several picks in a row
  - Consider adding a sort toggle later if you want alternatives beyond OVR-first

### 2026-03-30 — Draft page comfort/layout polish

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/styles.css`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Reworked the Draft tab into more of a drafting workspace centered around the available-player pool
  - Moved supporting information into smaller secondary cards and expanded the available-player panel
  - Added session summary pills and a compact progress indicator to make the page easier to read at a glance

- **Why**
  - The page should feel comfortable to sit on during a full draft, with the main picking surface always visible and easy to use

- **Known follow-up**
  - Verify the Draft tab on desktop and smaller widths to confirm the new sticky layout feels right

### 2026-03-30 — Draft room event/density pass

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/styles.css`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Reduced top-level draft chrome and tightened the on-clock presentation into a denser, more event-like stage card
  - Increased space for the available-player workspace while shrinking support-card footprint
  - Made player rows more compact so the draft pool feels faster and more focused

- **Why**
  - The Draft page should feel like a marquee event people want to sit with, not a spaced-out admin screen

- **Known follow-up**
  - Re-check whether the next pass should add a queue/watchlist and top-targets view instead of relying on the full available list alone

### 2026-03-30 — Draft queue + top-targets workflow

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/styles.css`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Added a mode-based right panel with `Top Targets`, `Queue`, and `Full Pool`
  - Added queue toggles on players so users can build a shortlist during the live draft
  - Fixed the draft search input by updating only the available-player panel instead of rerendering the entire draft page on each keystroke

- **Why**
  - A premium draft experience needs a shortlist workflow, not just one long list of available players
  - The search input bug was making the draft room frustrating to use in practice

- **Known follow-up**
  - Verify the queue flow and search behavior in the browser while making live picks

### 2026-03-30 — Draft density refinement

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/styles.css`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Compressed the overall Draft layout further by reducing spacing, support-card footprint, and player-row visual weight
  - Shortened labels and removed extra helper copy that was taking vertical space without helping the live draft flow
  - Preserved the newer panel workflow so the UI stays compatible with future manager self-pick behavior even though drafting remains admin-only today

- **Why**
  - The draft room still felt too large and padded relative to how much information actually matters during live picks

- **Known follow-up**
  - Decide whether the next pass should introduce manager-specific login/pick permissions once the live draft layout feels final

### 2026-03-30 — Draft pick regression fix

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Fixed the live draft `Pick` buttons after they stopped working in the new right-panel workflow
  - Centralized pick handling so dynamically rerendered player rows still wire up correctly

- **Why**
  - The right-panel refactor changed where player rows were rendered, which broke the original pick-button binding path

- **Known follow-up**
  - Re-test `Pick`, `Queue`, and search together in the browser after the regression fix

### 2026-03-30 — Draft room motion pass

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/styles.css`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Added a lightweight motion system that detects when the on-clock pick changes
  - Animated the stage card, available panel, and incoming target rows during draft transitions

- **Why**
  - The draft room still felt static even after the layout/panel improvements, so it needed controlled motion to feel alive

- **Known follow-up**
  - Decide whether to add a bigger pick-announcement/reveal moment later or keep the motion subtle

### 2026-03-30 — Draft panel smoothness fix

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Removed repeated event rebinding from the available-player panel update cycle
  - Switched panel interactions to delegated handlers so filters, mode buttons, queue toggles, and pick actions stay responsive through rerenders

- **Why**
  - The panel was accumulating interaction overhead during in-place rerenders, which made clicks feel unreliable and unsmooth

- **Known follow-up**
  - Re-test filter highlighting and panel responsiveness in the browser after repeated search/filter/mode changes

### 2026-03-30 — Draft motion rollback

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/styles.css`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Removed the scene-transition and animated row/panel behavior added in the motion pass
  - Restored the last working static draft-room interaction path

- **Why**
  - The animation layer introduced instability in the draft controls, and correctness is more important than motion

- **Known follow-up**
  - If motion is revisited later, it should be reintroduced in a smaller, safer way after interaction stability is locked down

### 2026-03-30 — Draft panel control restore

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Attached a stable click handler to the draft panel root after the panel content renders
  - Restored working position filters, queue toggles, mode buttons, and `Pick` actions in the right panel

- **Why**
  - The right-panel buttons were still being disconnected after rerenders, leaving core draft actions unusable

- **Known follow-up**
  - Re-test the full right-panel interaction flow in the browser after refresh

### 2026-03-30 — Draft filter active-state fix

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Updated the available-panel refresh path to rebuild the bottom position-filter chip row from current state

- **Why**
  - The filter was working functionally, but the button highlight was visually stale after panel updates

- **Known follow-up**
  - Refresh and confirm the bottom filter row now highlights correctly during repeated clicks

### 2026-03-30 — Draft team-scoped queue selector

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Added a dropdown to switch which manager/team queue you are editing
  - Updated queue mode and queue toggles to use manager-specific queue state
  - Removed drafted players from all team queues when they are selected

- **Why**
  - You wanted to jump between teams and set queues for them individually instead of managing one global watchlist

- **Known follow-up**
  - Re-test team switching and confirm each team retains its own queue after refresh/rerender

### 2026-03-30 — Queue-first auto draft

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Auto draft now prefers the active manager's queued players in order
  - If no valid queued player is available, it falls back to the prior position-need + OVR logic

- **Why**
  - If a manager supplies a queue, commissioner auto-picks should respect that preference list first

- **Known follow-up**
  - Re-test queue-first auto draft with multiple teams and invalid/expired queued players

### 2026-03-30 — Full draft board editing

- **Files changed**
  - `roster-app/draft.js`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Replaced the board's recent-picks slice with the full draft pick history
  - Preserved edit controls for every pick in the full scrollable board

- **Why**
  - You need to scroll back through the full draft and fix any mistaken pick, not just the most recent ones

- **Known follow-up**
  - Re-test editing older picks from deep in the draft board scroll

### 2026-03-30 — Settings safety pass

- **Files changed**
  - `roster-app/app.js`
  - `roster-app/styles.css`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Removed `Simulate Full Season` from the normal settings cards
  - Reintroduced it inside a collapsed `Advanced Settings` disclosure in the data/admin area so it stays hidden by default

- **Why**
  - Non-technical admins need the main settings flow to be safer and less likely to expose destructive actions by accident

- **Known follow-up**
  - Re-test the full settings page after the cleanup pass, especially manager assignment save behavior

### 2026-03-30 — Settings cleanup pass

- **Files changed**
  - `roster-app/app.js`
  - `roster-app/styles.css`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Removed the player-ratings import UI and related in-app ratings import logic
  - Added manager team counts and cleaner assignment summaries in Settings
  - Made the assignment cards easier to scan and manage visually

- **Why**
  - The ratings import flow no longer fits the streamlined admin experience, and the manager/team area needed to be easier for admins to understand at a glance

- **Known follow-up**
  - Re-test adding/removing managers and saving primary/co-manager assignments in the refreshed layout

### 2026-03-31 — Mobile navigation fix

- **Files changed**
  - `roster-app/styles.css`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Reworked the mobile header/nav CSS so the navigation becomes a horizontally scrollable bar
  - Increased nav button sizing and stabilized the sticky mobile header layout
  - Overrode the desktop full-width nav button sizing on phones so multiple sections can appear in the horizontal strip

- **Why**
  - Mobile users were effectively stuck on Dashboard because the desktop-style sidebar nav was not usable on small screens

- **Known follow-up**
  - Re-test section switching on an actual phone viewport and confirm swipe/tap behavior feels reliable

## Next Recommended Steps

1. Verify SYS-DATA upload/download/remove in the browser
2. Fix bot auth mismatch around `/pending`
3. Review bot approval auth boundary for score/trade approvals
4. Check Discord standings state-shape assumptions
5. Re-test player refresh and ratings import workflow after the SYS-DATA cleanup

### 2026-04-03 — Trade roster application fix

- **Files changed**
  - `roster-app/app.js`

- **What changed**
  - Added `applyTradeHistory()` — replays all trades in chronological order to set player `teamCode` values. Used as the single source of truth for roster assignments after any trade event.
  - Replaced the inline `give.forEach / recv.forEach` in `showNewTrade()` with `applyTradeHistory()` so all trades are consistently replayed rather than only applying the latest one
  - Fixed reverse trade: now does a manual swap first (to reset the reversed trade's players), removes the trade, then calls `applyTradeHistory()` on remaining trades so any subsequent trades are still correctly applied
  - Added `applyTradeHistory()` call at the end of `fetchNHLRosters()` so trade assignments survive any NHL API roster refresh — trades always win over API data
  - Corrected the existing broken trade in the test DB (Svechnikov/Henrique) as a side effect of the fix

- **Why**
  - The NHL API roster refresh was silently overwriting player `teamCode` values set by trades whenever a player ID match failed or a new player entry was created
  - The old per-trade forEach only applied the single new trade rather than ensuring all historical trades were reflected
  - The reverse trade was not re-applying subsequent trades correctly after removing a mid-history entry

- **Tested on test server**
  - Trade recorded via UI → player teamCodes updated server-side ✓
  - Simulated NHL API refresh → trade assignments preserved ✓
  - Trade reversed → players returned to correct teams, remaining trades still applied ✓
  - Multi-trade history maintained across operations ✓

- **Known follow-up**
  - None

### 2026-04-03 — Scores nav icon + mobile hamburger menu

- **Files changed**
  - `roster-app/styles.css`
  - `roster-app/index.html`
  - `roster-app/app.js`

- **What changed**
  - Added `◎` icon to the Scores nav button via `::before` CSS (was missing since it replaced Draft)
  - Added a hamburger button (`☰`) to the mobile header brand bar
  - On mobile (`max-width: 700px`) the nav is now hidden by default; tapping the hamburger toggles it open as a vertical dropdown
  - Hamburger button animates to an `✕` when open (CSS transform on the three spans)
  - Tapping any nav item closes the menu automatically
  - Nav dropdown layout is vertical/full-width on mobile instead of the previous horizontal scroll strip

- **Why**
  - Multiple users reported difficulty navigating on mobile; a hamburger menu is a standard pattern that cleans up the header and makes all sections reachable

- **Known follow-up**
  - None

### 2026-04-03 — Scores section + posted timestamps

- **Files changed**
  - `roster-app/index.html`
  - `roster-app/app.js`
  - `roster-app/styles.css`

- **What changed**
  - Replaced the Draft nav button with a Scores nav button (`data-section="scores"`)
  - Added `section-scores` to `index.html` (draft section and all draft code preserved untouched for next season)
  - Added `renderScores()` — a feed of all played regular-season games sorted by most-recently-posted first, with week filter buttons
  - Added `fmtDateTime()` helper that formats an ISO timestamp as `Apr 3 · 7:14 PM`
  - Stamped `postedAt` (ISO timestamp) onto each game when a score is saved via the admin modal
  - Dashboard Recent Results now sorts by `postedAt` first (falls back to `playedAt` then `date` for older games without timestamps)
  - Scoreboard cards on dashboard and Scores page show posted date/time; older games without `postedAt` fall back to showing the week number
  - Added `.sb-posted` CSS class for the timestamp label

- **Why**
  - Draft is over for the current season; nav space is better used for a scores feed
  - Posted timestamps let commissioners see which scores were entered most recently, not just which games are earliest in the schedule

- **Known follow-up**
  - Existing games in the DB have no `postedAt` — they will sort by week/date as before until scores are re-entered or the field is back-filled
  - Draft nav button can be restored for next season by swapping `scores` back to `draft` in `index.html`

### 2026-04-03 — Changelog audit + requirements fix

- **Files changed**
  - `roster-app/requirements.txt`
  - `roster-app/CHANGELOG_AGENT.md`

- **What changed**
  - Verified all 2026-03-30/31 changelog entries against the actual source files — all claims confirmed accurate
  - Added `PyJWT==2.8.0` to `requirements.txt` (was missing; `server/routes/auth.py` imports `jwt`)
  - Corrected the Architecture Notes port from `3000` to `3001` (actual default in `run.py` and `server.py`)

- **Why**
  - `PyJWT` omission would cause an `ImportError` on a clean `pip install -r requirements.txt`; port note was factually wrong

- **Known follow-up**
  - None introduced by this session — open follow-ups from prior sessions still stand

### 2026-04-03 — Discord bot compatibility fixes (pending.py)

- **Files changed**
  - `roster-app/server/routes/pending.py`

- **What changed**
  - `_apply_score()`: added `g['postedAt'] = datetime.now(timezone.utc).isoformat()` so bot-approved scores carry a posted timestamp and sort correctly in Recent Results / Scores feed (was missing; only UI-submitted scores had `postedAt`)
  - `_apply_trade()`: added `_apply_trade_history(state)` call after appending the new trade record
  - Added `_apply_trade_history(state)` Python helper — equivalent of the JS `applyTradeHistory()`: sorts all trades chronologically and updates player `teamCode` values from `playersSent` / `playersReceived`. Required because the Flask backend can't call JS functions.

- **Why**
  - Bot-approved scores were missing `postedAt` so they sorted below UI-posted scores in the feed regardless of when they were submitted
  - Bot-approved trades were appending a record to `state.trades` but never updating player `teamCode` — players would still appear on their old teams in rosters and in the `/trade` Discord autocomplete
  - Both issues had the same root cause as the original frontend trade bug fixed earlier this session, just in the server-side approval path

- **Tested**
  - Code review only; verified logic matches JS `applyTradeHistory()` exactly (sort by date, to_list normalization, same loop structure)

- **Known follow-up**
  - None for this session — bot standings (`standings.py`) confirmed unaffected (uses `g.get('played')` only, no `postedAt` dependency)

### 2026-04-03 — Weekly AI Power Rankings via Discord bot

- **Files changed**
  - `roster-app/bot/commands/powerrankings.py` (new)
  - `roster-app/bot/bot.py`
  - `roster-app/bot/config.py`
  - `roster-app/bot/.env`
  - `roster-app/bot/.env.example`
  - `roster-app/requirements.txt`

- **What changed**
  - New `bot/commands/powerrankings.py` cog with:
    - `_compute_power_rankings()` — Python port of app.js `calcPowerRankings()`: 60% recent form (L5 pts%) + 40% season record, sorted by prScore then pts
    - `_l5()` — Python port of app.js `l5Record()`: last 5 played non-playoff games per team
    - `_generate_comments()` — calls Groq API (llama-3.3-70b-versatile) with all team stats to generate one punchy sentence per team; falls back to template strings if `GROQ_API_KEY` is not set or Groq errors
    - `_build_embeds()` — returns two Discord embeds: top 10 with commentary (red), 11-32 compact list (grey)
    - `_save_last_week()` — POSTs updated state back to `/api/state` with admin JWT so rank-movement arrows (▲/▼) are accurate next week
    - `/powerrankings` slash command (admin only) — posts immediately to configured channel or current channel
    - `weekly_task` scheduled via `discord.ext.tasks` — fires daily at `POWER_RANKINGS_HOUR` UTC, gates on `POWER_RANKINGS_DAY` weekday; deduplicates via `_last_posted` date to prevent double-posts on bot restart
  - Added `groq>=0.9.0` to `requirements.txt`
  - Added 4 new config vars: `GROQ_API_KEY`, `POWER_RANKINGS_CHANNEL`, `POWER_RANKINGS_DAY`, `POWER_RANKINGS_HOUR`
  - Registered `bot.commands.powerrankings` in `EXTENSIONS` list in `bot.py`
  - `GROQ_API_KEY` written to `bot/.env`; template added to `bot/.env.example`

- **Why**
  - League wanted ESPN-style weekly power rankings with AI commentary posted automatically to Discord each week
  - Groq is free (console.groq.com), no credit card required; llama-3.3-70b produces natural, witty sports commentary
  - Rankings use the same 60/40 formula as the dashboard Power Rankings panel for consistency

- **Deployment steps**
  1. `pip install groq` (or `pip install -r requirements.txt`)
  2. Set `POWER_RANKINGS_CHANNEL` in `bot/.env` to the target Discord channel ID
  3. Optionally set `POWER_RANKINGS_DAY` (0=Mon) and `POWER_RANKINGS_HOUR` (UTC)
  4. Restart the bot — `/powerrankings` command available immediately; scheduled task fires on configured day

- **Known follow-up**
  - Test `/powerrankings` manually once bot is restarted with the new `POWER_RANKINGS_CHANNEL` set

## Update Rule For Future Sessions

For every meaningful session, add a short dated entry with:
- files changed
- what changed
- why it changed
- any known follow-up work
