# Zamboni League — NHL Legacy League Manager

A full-stack fantasy hockey league manager built for NHL Legacy leagues. Manage rosters, track scores, standings, trades, and league updates with a website-first player experience.

**Live Features:**
- 📊 Real-time standings with GF, GA, DIFF
- 🎮 Roster management (NHL API players + custom OVR/PLT ratings)
- 🏒 Website-native player portal with Discord OAuth login and score submission
- 🔄 Trade tracking with player ratings
- 🤖 Discord bot integration for posting links, updates, and notifications
- 📈 Season snapshots and historical standings
- ⚡ Fast, lightweight single-page app
- 🧾 Robust multi-user backend for links and score submissions

## Stack

- **Frontend** — vanilla JS SPA (`app.js` + `styles.css`), no frameworks
- **Backend** — Flask + SQLite (`server/`)
- **Discord Bot** — discord.py for posting, reminders, and website deep links (`bot/`)

## Quick Start

### 1. Install dependencies

```bash
pip install flask pyjwt python-dotenv aiohttp discord.py
```

### 2. Start the web server

```bash
# Windows
$env:NHL_BOT_SECRET="your-secret-here"
python run.py

# Linux/Mac
NHL_BOT_SECRET="your-secret-here" python run.py
```

Open `http://localhost:3000` — first visit creates `server/league.db` automatically.

### 3. Configure Discord OAuth for the website portal

Set these server environment variables before starting Flask:

```bash
DISCORD_CLIENT_ID=your_discord_app_id
DISCORD_CLIENT_SECRET=your_discord_client_secret
DISCORD_REDIRECT_URI=http://localhost:3000/api/v2/oauth/discord/callback
FLASK_SECRET_KEY=replace-with-a-stable-secret
```

This powers the website-native player portal login and account linking flow.

### 4. Set up the Discord bot (optional)

```bash
cp bot/.env.example bot/.env
```

Edit `bot/.env` with your Discord token and server details (see [Environment Variables](#environment-variables) below).

### 5. Start the bot

```bash
python -m bot.bot
```

The bot is now best used for posting league updates, reminders, and website links rather than hosting the main user workflows.

## Project Structure

```
roster-app/
├── index.html                    # App entry point
├── app.js                        # All frontend logic
├── styles.css                    # League styling
├── run.py                        # Production server
├── run_test.py                   # Test server (port 3001)
├── players_ovr_plt_all.txt       # Player ratings (auto-updated)
├── server/
│   ├── app.py                    # Flask + routes
│   ├── db.py                     # SQLite schema
│   ├── migrate_db.py             # Migration helper for dedicated user-facing tables
│   ├── schema_migrations.sql     # SQL schema for robust multi-user storage
│   ├── routes/
│   │   ├── auth.py               # JWT authentication
│   │   ├── state.py              # League state GET/POST
│   │   ├── games.py              # Teams, scores
│   │   ├── pending.py            # Approval queue
│   │   ├── user_portal.py        # Original website portal routes
│   │   ├── user_portal_v2.py     # Robust website-first portal routes
│   │   └── zamboni.py            # Zamboni proxy endpoints
│   └── botmanager.py             # Bot process control
└── bot/
    ├── bot.py                    # Discord client
    ├── config.py                 # Environment config
    ├── api.py                    # Flask API client
    ├── auth.py                   # JWT token storage
    ├── embeds.py                 # Discord embed builders
    ├── .env.example              # Environment template
    └── commands/
        ├── score.py              # legacy /score command (transitioning away from interactive flow)
        ├── trade.py              # /trade command
        ├── standings.py          # /standings command
        └── pending.py            # /pending command (admin)
```

## Discord Bot Commands

| Command | Who | Purpose |
|---|---|---|
| `/score` | Anyone | Transitional command that should point users to the website portal |
| `/standings` | Anyone | View top-5 standings preview + link to full site |
| `/trade` | Admin | Record a trade between two teams |
| `/pending` | Admin | List and approve/reject pending submissions |
| `/botlogin` | Admin | Authenticate bot with admin password |

## Website-First Player Portal

The main player workflow now lives on the website.

### Player-facing website features

- Discord OAuth login
- manager linking with RPCN / Zamboni tag validation
- mobile-friendly score portal
- Zamboni-assisted score matching with manual fallback
- client-side prefetch/cache for recent eligible games
- team logo, current record, and portal dashboard polish

### Robust backend architecture

The website portal now uses dedicated tables for user-facing actions:

- `user_links` — Discord account to manager link records
- `score_submissions` — atomic score submissions with audit trail
- `trade_offers` — future trade workflow storage

This avoids relying entirely on broad `league_state` rewrites for real-time player activity and makes concurrent submissions safer.

## Environment Variables

### Server (`run.py`)

| Variable | Default | Purpose |
|---|---|---|
| `NHL_BOT_SECRET` | *(required)* | Shared secret between server and bot (must match bot's `NHL_BOT_SECRET`) |
| `NHL_JWT_SECRET` | `nhl-legacy-league-secret-change-me` | JWT signing key (change in production!) |
| `DISCORD_CLIENT_ID` | *(recommended)* | Discord OAuth app client ID for website login |
| `DISCORD_CLIENT_SECRET` | *(recommended)* | Discord OAuth app client secret for website login |
| `DISCORD_REDIRECT_URI` | *(recommended)* | OAuth callback URL for website login |
| `FLASK_SECRET_KEY` | *(recommended)* | Stable Flask session secret for website sessions |
| `APP_BASE_PATH` | `/` | Base path for website redirects (`/` locally, `/league` if deployed under a subpath) |
| `APP_URL` | *(optional but recommended)* | Public-facing website URL used for startup visibility and bot deep-link coordination |
| `PORT` | `3000` | Server port |

### Production notes

- Set a stable `FLASK_SECRET_KEY` before production so website sessions survive restarts.
- If the website is deployed under a subpath, set `APP_BASE_PATH` to match it exactly.
- `DISCORD_REDIRECT_URI` should point to the v2 portal callback path:
  - `/api/v2/oauth/discord/callback`
- `APP_URL` should be the public website URL, not localhost, in production.

### Bot (`bot/.env`)

| Variable | Required | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from Discord Developer Portal |
| `NHL_BOT_SECRET` | ✅ | Matches server `NHL_BOT_SECRET` |
| `ADMIN_PASSWORD` | ✅ | Admin password for league (used by `/botlogin`) |
| `GUILD_ID` | ✅ | Discord server ID (right-click server → Copy Server ID) |
| `ADMIN_ROLE_ID` | ✅ | Admin role ID (right-click role → Copy Role ID) |
| `API_BASE` | ✅ | Server URL (`http://localhost:3000` for dev) |
| `APP_URL` | ✅ | Public-facing URL (same as `API_BASE` or your domain) |
| `SCORES_CHANNEL` | ✅ | Discord channel for score posts |
| `TRADES_CHANNEL` | ✅ | Discord channel for trade posts |
| `PENDING_CHANNEL` | ✅ | Discord channel for approval/admin messages |

## Key Features

### Website Score Submission

1. Player signs into the website with Discord OAuth
2. Links their manager account and RPCN / Zamboni tag
3. Opens the mobile-friendly score portal
4. Selects an eligible league game
5. Picks a matching Zamboni result or falls back to manual entry
6. Score submission is stored atomically with audit metadata
7. Approved result updates league state and website standings

### Multi-user robustness

- dedicated `user_links` and `score_submissions` tables
- atomic score submission records
- conflict detection for already-scored games
- audit trail for who submitted what and when
- safer foundation for concurrent nightly use

### Discord Embeds

- **Score Result** — Discord post for newly approved scores with website-first flow support
- **Trade Wire** — Green embed with player OVR/PLT ratings
- **Standings** — Top-5 teaser with link to full site
- **Pending** — Gold embed for approvals (sent to admins via DM + channel)

### Standings

Displays:
- **W-L-OT** record
- **PTS** (2 pts per win, 1 pt per OT loss)
- **GF** (goals for)
- **GA** (goals against)
- **DIFF** (goal differential, color-coded)

### Admin Panel

**Settings** tab (admin login) includes:
- Team/Manager setup
- Player roster management (NHL API players with custom OVR/PLT)
- Discord bot control
- Discord channel configuration (scores, trades, pending, approvals)
- Season snapshots

## Deployment

### Local Development
```bash
python run.py                    # Web server (port 3000)
python -m bot.bot                # Discord bot
```

### Production (Linux VPS)

```bash
# Clone repo
git clone <repo-url>
cd roster-app

# Install deps
pip install -r requirements.txt

# Set environment
export NHL_BOT_SECRET="your-secret"
export NHL_JWT_SECRET="strong-random-key"
export PORT=3000

# Start server (use systemd/pm2 for background)
python run.py

# Start bot (separate service)
python -m bot.bot
```

## Troubleshooting

**Website portal says account is not linked**
- Sign in through Discord OAuth first
- Link your manager account in the player portal
- Make sure your RPCN / Zamboni tag is valid

**Score submission says game was already scored**
- Another user may have submitted it first
- Refresh the portal and try another eligible game
- This is expected conflict protection in the new robust flow

**Bot not sending messages to Discord**
- Verify `SCORES_CHANNEL`, `TRADES_CHANNEL`, `PENDING_CHANNEL` are set correctly
- Check that the bot has permission to send messages in those channels
- Confirm bot is authenticated (`/botlogin` in Discord)

**Admin login fails**
- On first setup, any password is accepted and becomes the admin password
- Subsequent logins must match the stored hash
- Check `NHL_JWT_SECRET` matches between server and requests

**Players not showing in roster**
- Make sure the NHL API is reachable (check network)
- Player OVR/PLT ratings should be in `players_ovr_plt_all.txt`
- Try fetching fresh player data from NHL API in the admin panel

## For Users & Admins

See detailed guides:
- **[USER_GUIDE.md](USER_GUIDE.md)** — How to submit scores, view standings, manage rosters
- **[ADMIN_GUIDE.md](ADMIN_GUIDE.md)** — How to set up and manage the league

See roadmap docs in `upgrades/` for:
- website robustness planning
- bot posting refactor direction

## License

Private use. Built for NHL Legacy League communities.
