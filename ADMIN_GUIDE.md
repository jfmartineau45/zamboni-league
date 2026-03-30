# Admin Guide — Zamboni League Setup & Management

This guide is for **league administrators** setting up and managing a Zamboni League.

## Initial Setup

### 1. Server & Database

Start the web server:

```bash
# Windows
$env:NHL_BOT_SECRET="your-secret-here"
python run.py

# Linux
NHL_BOT_SECRET="your-secret-here" python run.py
```

Navigate to `http://localhost:3000`

**First time?** The database `server/league.db` is created automatically. You can log in with any password — it becomes your admin password.

### 2. Discord Bot Setup

#### Create a Discord App

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**
3. Name it (e.g., "Zamboni League Bot")
4. Go to **Bot** → **Add Bot**
5. Under **TOKEN**, click **Copy** — save this securely
6. Enable **Message Content Intent** (under Privileged Gateway Intents)

#### Invite Bot to Server

1. Go to **OAuth2 → URL Generator**
2. Select scopes: `bot`
3. Select permissions:
   - `Send Messages`
   - `Read Message History`
   - `Read Messages/View Channels`
4. Copy the URL and open it in a browser
5. Select your Discord server and authorize

#### Configure Bot Environment

Create `bot/.env`:

```bash
cp bot/.env.example bot/.env
# Edit with your values
```

**Required settings:**

```
DISCORD_TOKEN=your_bot_token_here

NHL_BOT_SECRET=your-secret-here
ADMIN_PASSWORD=your_admin_password_here

GUILD_ID=your_discord_server_id
ADMIN_ROLE_ID=your_admin_role_id

API_BASE=http://localhost:3000
APP_URL=http://localhost:3000

SCORES_CHANNEL=your_scores_channel_id
TRADES_CHANNEL=your_trades_channel_id
PENDING_CHANNEL=your_approval_channel_id
```

**How to get Discord IDs:**
1. Enable **Developer Mode** in Discord (User Settings → Advanced → Developer Mode)
2. Right-click server/channel/role
3. Click **Copy Server/Channel/Role ID**

### 3. Start the Bot

```bash
python -m bot.bot
```

Or use the **🤖 Discord Bot** panel in the website's Settings (easier).

## Admin Panel

**Login:** Click **ADMIN** (top right of web app) → enter your password

### Teams & Managers

**TEAMS tab:**
- Add teams (NHL team codes: NYR, BOS, TOR, etc.)
- Assign a manager to each team
- Edit team details

**MANAGERS tab:**
- Add league managers with names
- Assign managers to teams

### Players & Rosters

**PLAYERS tab:**
- View all players in the NHL (pulled from NHL API)
- Edit OVR (overall rating) and PLT (position) for each player
- Changes apply instantly across all rosters

**Roster Management:**
- Each team's roster is managed from the **TEAMS tab**
- Add/remove players from team rosters
- Player OVR/PLT ratings are stored locally in `players_ovr_plt_all.txt`
- Rosters sync with NHL player database automatically

### Discord Configuration

**Settings → Discord Channels:**
- **Scores Channel ID** — where score results post
- **Trades Channel ID** — where trades post
- **Pending/Approvals Channel ID** — where approval requests go
- **DM admins for approvals** — toggle DMs on/off

Changes save immediately; Discord embeds respect these settings.

### Score Approvals

**Pending tab:**
Shows all pending score submissions waiting for approval.

For each pending score:
- See the game (home vs away)
- See the scores
- See who submitted it

**Actions:**
- ✅ **Approve** → Game recorded, result posted to Discord, standings update
- ❌ **Reject** → Score discarded, manager notified

### Trade Management

**Trades tab:**
- View all recorded trades
- Edit or delete trades (if needed)
- Record new trades manually

When a trade is approved:
- Appears in Discord (`#trades` channel)
- Players transfer between rosters
- Website trade history updates

### Season Management

**Dashboard → Season (⚙️ button):**
- **Set Week** — Manually override current week (useful for leagues with staggered schedules)
- **Clear Week** — Auto-calculate week from unplayed games

### Save Season Snapshot

**Season History:**
- Captures current standings at any point
- Useful for tracking progress across seasons
- Shows final standings when season ends

## Approving Scores

### Flow

1. Manager submits `/score` in Discord
2. Pending message appears in approval channel (+ admin DM if enabled)
3. Admin clicks ✅ **Approve**
4. **Instant updates:**
   - Game marked as played
   - Standings recalculate
   - Result embed posts to `#scores`
   - Manager notified via DM

### Common Issues

**"Game not found"**
- Ensure game exists in current week's schedule
- Check home/away teams match exactly

**Score not posting to Discord**
- Verify `SCORES_CHANNEL` ID is correct in Settings
- Check bot has permission to send in that channel
- Ensure bot is authenticated (`/botlogin`)

**Admin not getting DM**
- Check DM setting in Settings → Discord Channels
- Verify admin has DMs enabled from bot
- Check `ADMIN_ROLE_ID` is correct

## Commands (Admin-Only)

### `/pending` — List and approve/reject
Shows all pending items with Approve/Reject buttons.

### `/trade` — Record a trade
```
/trade from_team:BOS to_team:NYR players_sent:player1,player2 players_received:player3 notes:optional_notes
```

### `/botlogin` — Re-authenticate bot
Authenticate the bot with the admin password (one-time setup, but useful if token expires).

## Best Practices

**✅ Do:**
- Verify scores before approving (correct teams, correct scores)
- Keep player OVR/PLT ratings updated (impacts trade visibility)
- Monitor pending approvals regularly
- Use Discord channels for public results + approvals
- Back up your database regularly (`server/league.db`)

**❌ Don't:**
- Share admin password with non-admins
- Change `NHL_BOT_SECRET` mid-season (breaks bot auth)
- Delete games directly from database (use reject workflow)
- Approve obviously wrong scores without checking

## Database Management

**Location:** `server/league.db` (SQLite)

**Backup:**
```bash
cp server/league.db server/league.db.backup
```

**Access with SQLite CLI:**
```bash
sqlite3 server/league.db
```

## Deployment to Production

### Linux VPS

```bash
# Clone and setup
git clone <repo-url>
cd roster-app
pip install -r requirements.txt

# Create environment file
cat > .env << EOF
NHL_BOT_SECRET=your-secret
NHL_JWT_SECRET=strong-random-key
PORT=3000
EOF

# Start as background service (using systemd)
sudo nano /etc/systemd/system/zamboni-web.service
```

**systemd service file:**
```ini
[Unit]
Description=Zamboni League Web Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/roster-app
Environment="NHL_BOT_SECRET=your-secret"
Environment="NHL_JWT_SECRET=strong-random-key"
ExecStart=/usr/bin/python3 run.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable zamboni-web
sudo systemctl start zamboni-web
```

### Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Troubleshooting

**Bot won't start**
- Check `DISCORD_TOKEN` is valid (no spaces, correct token)
- Verify `NHL_BOT_SECRET` matches server's secret
- Check bot has required Discord permissions

**Can't log in to admin panel**
- On first visit, any password works and becomes the admin password
- If locked out, reset via database:
  ```bash
  sqlite3 server/league.db
  UPDATE league_state SET data='{}' WHERE id=1;
  ```

**Standings not updating after approval**
- Check the game was marked as `played: true` in database
- Verify standings calculation includes the game
- Try refreshing the page (Ctrl+F5)

**Discord embeds not posting**
- Verify bot has permission to send messages in channel
- Check channel ID is correct in Settings
- Bot should be authenticated (check `/botlogin`)

## Support

For issues:
1. Check logs in bot terminal
2. Verify environment variables are set correctly
3. Test Discord bot permissions
4. Check database integrity with SQLite

---

**Need help?** Check [README.md](README.md) for architecture details or [USER_GUIDE.md](USER_GUIDE.md) for user commands.
