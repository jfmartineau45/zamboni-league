# User Guide — Zamboni League

This guide is for **league managers** who want to submit scores, view standings, and track their team's performance.

## Dashboard

When you first open the site, you see the **Dashboard** — your league's quick overview.

**What's on the dashboard:**
- **🔥 Hottest / ❄️ Coldest** — Teams with the best/worst records in their last 5 games
- **⚡ Bubble Gap** — Points separating the #16 team (in playoffs) from #17 (out)
- **📅 Season** — Current week and number of games played
- **Recent Results** — Last 6 games that have been played
- **Upcoming Games** — This week's unplayed games
- **Recent Trades** — Latest trades recorded in the league

## Submitting a Score

**Discord Command:** `/score`

### Step by step:

1. **In your league's Discord**, run the `/score` command
2. **Pick the game** from the autocomplete list
   - Shows only this week's unplayed games
   - Type to filter (e.g., type "NYR" to see all NYR games)
3. **Enter home team score**
4. **Enter away team score**
5. **Mark as OT?** (optional)
   - Only if the game went to overtime/shootout
6. **Submit**
   - You'll see: *"Submitted! Waiting for admin approval."*

### What happens next:

1. **Admin gets notified** via DM or the approval channel
2. **Admin approves or rejects** the score
3. **If approved:**
   - Your game is recorded
   - A result card appears in the `#scores` channel (showing both teams, final score, manager names)
   - Standings update immediately
   - Website shows the new game as played

### Important:

- Scores **must have a winner** (no ties in NHL)
- You can only submit games from **this week's schedule**
- Once a game is recorded, you **cannot edit it** (ask admin to reject and resubmit)

## Viewing Standings

**Click: STANDINGS** (left sidebar)

Shows the full league standings with:
- **Rank** (position in league)
- **Team Code** (NYR, BOS, etc.)
- **Manager Name** (your name)
- **GP** — Games Played
- **W-L-OT** — Wins, Losses, Overtime Losses
- **PTS** — Points (2 per win, 1 per OT loss)
- **GF** — Goals For (total goals scored)
- **GA** — Goals Against (total goals allowed)
- **DIFF** — Goal Differential (GF - GA, color-coded)

## Checking Your Team

**Click: TEAMS** (left sidebar)

View all teams in the league:
- Your roster (players + their OVR/PLT ratings)
- Team record
- Manager name
- Click your team to see full details

## Schedule & Results

**Click: SCHEDULE** (left sidebar)

See all games this season:
- Filter by team (your team, specific opponent, etc.)
- Filter by status (upcoming games, past results, all)
- Shows dates, scores, and manager names

## Trades

When a trade is recorded by an admin:
1. A **trade card appears in Discord** with both teams' players
2. The **Trades tab** on the website shows full trade history
3. You can see which players were sent/received and when

## Discord Bot Commands (Public)

### `/score` — Submit a game result
```
/score game:<game> home_score:<#> away_score:<#> overtime:<yes/no>
```
- Game: Pick from autocomplete (this week only)
- Home score: Number (0-20)
- Away score: Number (0-20)
- Overtime: Yes/No (default: No)

### `/standings` — Quick standings preview
```
/standings conference:<optional>
```
- Shows top 5 teams
- Links to full standings on the website
- Filter by conference (East/West) if your league uses them

## Tips & Tricks

**✅ Do:**
- Submit scores as soon as games are played
- Check the schedule before submitting (don't submit wrong game)
- Use Discord's autocomplete to avoid typos

**❌ Don't:**
- Try to submit tied games (not allowed in NHL)
- Sumbit games from other weeks (only current week shows in autocomplete)
- Edit scores manually (only admins can do that)

## Frequently Asked Questions

**Q: Why don't I see all games in the autocomplete?**
- Only unplayed games from **this week** show
- If you don't see a game, it might already be recorded or be from a different week

**Q: Can I submit a score for a past week?**
- No — you can only submit games from the current week
- Contact your admin if you need to record a score from an earlier week

**Q: What's the difference between W/L/OT?**
- **W** — Regulation win (3 points)
- **L** — Regulation loss (0 points)
- **OT** — Overtime/shootout loss (1 point)

**Q: Why didn't my score post?**
- An admin probably rejected it
- Check your DM — admin may have left a note
- Try submitting again with correct scores

**Q: How are standings calculated?**
- **Points** = (Wins × 2) + (OT Losses × 1)
- **Standings rank** = Highest points first
- Tiebreaker: Regulation wins, then goal differential

## Need Help?

Ask your **league admin** for:
- Password reset
- Manual score correction
- Trade approval issues
- Discord setup questions
