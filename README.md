# Zamboni League — NHL Legacy League Manager

A full-stack fantasy hockey league manager built for NHL Legacy (PS3) leagues. Manage rosters, track scores, standings, trades, and Discord notifications — all in one place.

**Live Features:**
- 📊 Real-time standings with GF, GA, DIFF
- 🎮 Roster management (import from PS3 SYS-DATA files)
- 🏒 Score submission and admin approval workflow
- 🔄 Trade tracking with player ratings
- 💬 Discord bot integration with rich embeds
- 📈 Season snapshots and historical standings
- ⚡ Fast, lightweight single-page app

## Stack

- **Frontend** — vanilla JS SPA (`app.js` + `styles.css`), no frameworks
- **Backend** — Flask + SQLite (`server/`)
- **Discord Bot** — discord.py with slash commands (`bot/`)

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

### 3. Set up the Discord bot (optional but recommended)

```bash
cp bot/.env.example bot/.env
```

Edit `bot/.env` with your Discord token and server details (see [Environment Variables](#environment-variables) below).

### 4. Start the bot

```bash
python -m bot.bot
```

Alternatively, use the **🤖 Discord Bot** control panel in the web app's Settings (admin login required) for easy start/stop without needing a terminal.

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
│   ├── routes/
│   │   ├── auth.py               # JWT authentication
│   │   ├── state.py              # League state GET/POST
│   │   ├── games.py              # Teams, scores
│   │   ├── pending.py            # Approval queue
│   │   └── sysdata.py            # PS3 file upload/download
│   └── botmanager.py             # Bot process control
└── bot/
    ├── bot.py                    # Discord client
    ├── config.py                 # Environment config
    ├── api.py                    # Flask API client
    ├── auth.py                   # JWT token storage
    ├── embeds.py                 # Discord embed builders
    ├── .env.example              # Environment template
    └── commands/
        ├── score.py              # /score command
        ├── trade.py              # /trade command
        ├── standings.py          # /standings command
        └── pending.py            # /pending command (admin)
```

## Discord Bot Commands

| Command | Who | Purpose |
|---|---|---|
| `/score` | Anyone | Submit a game result for this week (requires admin approval) |
| `/standings` | Anyone | View top-5 standings preview + link to full site |
| `/trade` | Admin | Record a trade between two teams |
| `/pending` | Admin | List and approve/reject pending submissions |
| `/botlogin` | Admin | Authenticate bot with admin password |

## Environment Variables

### Server (`run.py`)

| Variable | Default | Purpose |
|---|---|---|
| `NHL_BOT_SECRET` | *(required)* | Shared secret between server and bot (must match bot's `NHL_BOT_SECRET`) |
| `NHL_JWT_SECRET` | `nhl-legacy-league-secret-change-me` | JWT signing key (change in production!) |
| `PORT` | `3000` | Server port |

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
| `PENDING_CHANNEL` | ✅ | Discord channel for approval requests |

## Key Features

### Score Submission & Approval

1. Manager runs `/score` in Discord
2. Selects game from this week's schedule
3. Enters home/away scores + OT flag
4. Score goes to admin for approval
5. Admin approves → game recorded + result posted to Discord
6. Website standings update automatically

### Discord Embeds

- **Score Result** — Red embed with team logos, manager names, final score
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
- Player roster imports (from PS3 SYS-DATA)
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

**"Game not found" on /score**
- Make sure the game exists in the schedule
- Current week is calculated as the lowest week with unplayed games

**Bot not sending messages to Discord**
- Verify `SCORES_CHANNEL`, `TRADES_CHANNEL`, `PENDING_CHANNEL` are set correctly
- Check that the bot has permission to send messages in those channels
- Confirm bot is authenticated (`/botlogin` in Discord)

**Admin login fails**
- On first setup, any password is accepted and becomes the admin password
- Subsequent logins must match the stored hash
- Check `NHL_JWT_SECRET` matches between server and requests

**SYS-DATA import shows no players**
- Make sure the PS3 file was exported correctly from NHL Legacy
- File must be a valid PS3 RosterFile binary

## For Users & Admins

See detailed guides:
- **[USER_GUIDE.md](USER_GUIDE.md)** — How to submit scores, view standings, manage rosters
- **[ADMIN_GUIDE.md](ADMIN_GUIDE.md)** — How to set up and manage the league

## License

Private use. Built for NHL Legacy League communities.
