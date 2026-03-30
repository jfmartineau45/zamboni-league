# Zamboni.gg — NHL Legacy League Manager

A full-stack fantasy hockey league manager built for NHL Legacy (PS3) leagues.

## Stack

- **Frontend** — single-page app (`roster-app/app.js` + `styles.css`)
- **Backend** — Flask + SQLite (`roster-app/server/`)
- **Discord Bot** — discord.py (`roster-app/bot/`)

## Quick Start

### 1. Install dependencies
```bash
cd roster-app
pip install flask pyjwt python-dotenv aiohttp discord.py playwright
playwright install chromium
```

### 2. Start the web server
```bash
# Windows
$env:NHL_BOT_SECRET="your-secret-here"
python run.py

# Linux
NHL_BOT_SECRET="your-secret-here" python run.py
```

Open `http://localhost:3000` — first visit creates `server/league.db` automatically.

### 3. Set up the Discord bot
```bash
cd bot
cp .env.example .env
# Edit .env with your Discord token, server IDs, and bot secret
```

### 4. Start the bot
Either run it manually:
```bash
cd roster-app
python -m bot.bot
```
Or use the **🤖 Discord Bot** panel in Settings (admin login required) to start/stop it from the website — no terminal access needed.

## Project Structure

```
roster-app/
├── index.html              # App entry point
├── app.js                  # All frontend logic (~3500 lines)
├── styles.css              # Styles
├── run.py                  # Start production server (port 3000)
├── run_test.py             # Start isolated test server (port 3001)
├── players_ovr_plt_all.txt # Player OVR/PLT ratings (auto-updated on edits)
├── server/
│   ├── server.py           # Flask app + API routes
│   ├── db.py               # SQLite init
│   ├── botmanager.py       # Bot process manager
│   └── routes/             # API blueprints
│       ├── auth.py         # POST /api/auth
│       ├── state.py        # GET/POST /api/state
│       ├── games.py        # GET /api/teams, POST /api/bot/score
│       ├── pending.py      # Pending approvals queue
│       └── sysdata.py      # SYS-DATA upload/download
└── bot/
    ├── bot.py              # Discord client entry point
    ├── config.py           # Env var loader
    ├── api.py              # Flask API helpers
    ├── screenshot.py       # Playwright screenshot helper
    ├── .env.example        # Copy to .env and fill in
    └── commands/
        ├── score.py        # /score — submit game result
        ├── trade.py        # /trade — admin trade entry
        ├── standings.py    # /standings — top 5 preview
        └── pending.py      # /pending — admin approval queue
```

## Discord Bot Commands

| Command | Who | Description |
|---|---|---|
| `/score` | Anyone | Submit a game result (goes to admin approval) |
| `/standings` | Anyone | Top 5 standings preview + link to site |
| `/trade` | Admin | Record a trade with autocomplete dropdowns |
| `/pending` | Admin | List and approve/reject pending items |
| `/botlogin` | Admin | Authenticate bot as admin |

## Environment Variables

See `roster-app/bot/.env.example` for all bot variables.

Server variables (set before running `run.py`):

| Variable | Default | Description |
|---|---|---|
| `NHL_BOT_SECRET` | *(empty)* | Shared secret between server and bot |
| `NHL_JWT_SECRET` | `nhl-legacy-league-secret-change-me` | JWT signing key |
| `PORT` | `3000` | Server port |
