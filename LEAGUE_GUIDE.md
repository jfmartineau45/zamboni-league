# NHL Legacy League Manager — Community Guide

> A browser-based league management app built for the NHL Legacy League.
> No install required — just open the page and go.

---

## Getting Started

- Open the app in your browser
- The admin logs in via **Admin Login** (top-right) to unlock write access
- Regular members can view everything without logging in

---

## Dashboard

Your league at a glance.

- **Stat Cards** — Season record totals (W / L / OT) and active managers across the league
- **Recent Results** — Last 5 completed games shown as NHL-style scoreboard rows with team logos, final scores, OT/SO indicators, and manager names
- **Upcoming Games** — Next 5 scheduled matchups with dates and manager names
- **Playoff Race** — Live bubble tracker showing teams ranked 10–22. A dividing line marks the playoff cutoff (top 16 advance). Each row shows the team's point differential vs the cutline — green means in, red means out

---

## Teams

All 32 NHL franchises with their assigned managers.

- Teams grouped with their league manager (and co-manager if applicable)
- Player roster listed per team with OVR / SKT / SHT / CHK / DEF ratings
- Search bar to filter across all teams at once
- Read-only for non-admins

---

## Players

Full player database loaded from NHL rosters.

- **Search** by name
- **Filter by team** using the dropdown
- **Sort** by any column — Name, Team, OVR, PLT — click the header once for ascending, again for descending
- Roster data auto-refreshes from NHL.com on startup (silently, in the background) and re-checks every 30 days
- Admin can trigger a manual **Refresh Roster** at any time from Settings

---

## Draft

Manage your league's team-selection draft.

- **Draft Order** — Admin sets the order by picking managers; drag to rearrange
- **Draft Board** — Visual grid showing all 32 picks as they happen; each cell shows which manager took which team
- **Make Picks** — Admin advances the draft pick-by-pick; the current pick is highlighted
- **Player Draft** — Secondary draft tab for individual player picks (rounds and teams)
- Team assignments update automatically as draft picks are recorded
- Draft can be reset by the admin at any time

---

## Schedule

The full season calendar.

- **Add Game** (admin) — Manually schedule a matchup: home team, away team, week number, date
- **Generate Schedule** (admin) — Auto-build a round-robin schedule across all managed teams. Choose start date, games per week, number of weeks, and preferred game days (Mon / Wed / Fri etc.). The app shuffles all team pairs and fills the calendar
- **Record Result** (admin) — Click any scheduled game to enter the final score, overtime/shootout flag, and winning team
- Games are shown by week with team logos, manager names, and status badges

---

## Standings

Live league table updated after every result.

- Full 32-team table sorted by Points (Pts)
- Columns: GP, W, L, OTL, Pts, GF, GA, +/−
- Team logo and manager name shown per row
- Top 16 teams qualify for playoffs (highlighted)
- **View Playoffs** button appears once a bracket has been generated

---

## Playoffs

Full bracket view — separate from the standings table.

- **Champion Banner** — Winning team displayed at the top with large team logo once the series is complete
- **Bracket Rounds** — Each round shown as a matchup card with team logos (28px), manager names, and series record (e.g. 4–2)
- Admin can record results from the Schedule section; the bracket updates live

---

## Trades

League trade log.

- **Record Trade** (admin) — Log a trade between two teams: list of assets going each direction (players, picks, etc.) and the trade date
- All completed trades displayed as cards in reverse-chronological order
- Non-admins see a read-only view with a note to contact the league admin for trade recording
- Admin can delete any trade record

---

## Settings

League configuration — most options are admin-only.

### League Info
- Set the **League Name** (shown in the header)
- Set the **Admin Password** (used for the Admin Login button)

### Managers
- Add managers by name — each gets an auto-assigned color
- Delete managers (removes their team assignments automatically)

### Team Assignments
- Assign any NHL team to a manager using the dropdown
- Set a **Co-Manager** for teams that have two managers — both names appear throughout the app as "Manager1 / Manager2"
- Hit **Save Assignments** after making changes
- Assignments also update automatically when picks are made in the Draft

### NHL Roster Data
- **Refresh Roster** — Pull the latest player data from NHL.com
- Roster refreshes automatically on startup; this button is for manual updates only

### Season Management *(admin only)*
- **Save Season Snapshot** — Archives the current season (games, standings, draft, trades, playoffs) with a label
- **Start New Season** — Saves a snapshot and resets the league for the next season (season counter increments: S1 → S2 → S3)
- **Season History** — Lists all archived seasons; admin can View details, Load (restore as current), or Delete each snapshot
- Data that carries over between seasons: managers, team assignments, players, settings
- Data that resets: games, schedule, draft, trades, playoff bracket

### Import / Export
- **Export** — Download all league data as a JSON file (backup / migration)
- **Import** — Paste a JSON export to restore league data on a new browser or device

---

## Notes for Members

- **No account needed** — just open the link to view everything
- **Admin actions** are clearly marked and require the admin password
- The app stores all data locally in your browser — the admin's browser is the source of truth; use Export/Import to sync between devices
- Team logos are pulled live from NHL.com CDN

---

*NHL Legacy League Manager — built for the community.*
