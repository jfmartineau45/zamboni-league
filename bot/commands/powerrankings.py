"""
commands/powerrankings.py — Weekly AI-generated power rankings

Scheduled: posts every POWER_RANKINGS_DAY at POWER_RANKINGS_HOUR UTC
Command:   /powerrankings  (admin only, posts immediately)
"""
import datetime
import json
import logging
import re

import discord
from discord import app_commands
from discord.ext import commands, tasks

from bot.api import get_state
from bot import config
from bot.commands.standings import _compute_standings

log = logging.getLogger('nhl-bot')

SITE_RED  = 0xCE1126
SITE_GREY = 0x2B2D31
MEDALS    = {1: '🥇', 2: '🥈', 3: '🥉'}

# UTC time the scheduled task fires daily (weekday check gates actual post)
_TASK_TIME = datetime.time(hour=config.POWER_RANKINGS_HOUR, tzinfo=datetime.timezone.utc)


# ── Power rankings calculation ─────────────────────────────────────────────────

def _l5(team_code, games):
    """Last-5-games record — port of app.js l5Record()."""
    played = [
        g for g in games
        if g.get('played') and not g.get('playoff')
        and (g.get('homeTeam') == team_code or g.get('awayTeam') == team_code)
    ]
    played.sort(
        key=lambda g: g.get('postedAt') or g.get('playedAt') or g.get('date') or '',
        reverse=True,
    )
    w = l = ot = 0
    for g in played[:5]:
        hs  = int(g.get('homeScore', 0))
        as_ = int(g.get('awayScore', 0))
        winner = g.get('homeTeam') if hs > as_ else g.get('awayTeam')
        if winner == team_code:
            w += 1
        elif g.get('ot'):
            ot += 1
        else:
            l += 1
    return {'w': w, 'l': l, 'ot': ot, 'pts': w * 2 + ot, 'games': w + l + ot}


def _compute_power_rankings(state):
    """
    Port of app.js calcPowerRankings().
    60% recent form (L5 pts%) + 40% season record (pts%).
    Returns list sorted by prScore DESC, pts DESC.
    """
    standings = _compute_standings(state)
    games     = state.get('games', [])
    last_week = state.get('powerRankingsLastWeek', {})

    ranked = []
    for s in standings:
        code = s['code']
        l5   = _l5(code, games)
        gp   = s['gp']
        form_pct   = (l5['pts'] / (l5['games'] * 2)) if l5['games'] else 0
        season_pct = (s['pts']  / (gp * 2))           if gp           else 0
        ranked.append({
            **s,
            'l5':       l5,
            'prScore':  form_pct * 0.6 + season_pct * 0.4,
            'lastRank': last_week.get(code),
        })

    ranked.sort(key=lambda x: (-x['prScore'], -x['pts']))
    for i, r in enumerate(ranked, 1):
        r['prRank'] = i
        last = r['lastRank']
        r['prDiff'] = (last - i) if last else None   # positive = moved up

    return ranked


# ── AI commentary ──────────────────────────────────────────────────────────────

def _mgr_name(state, code):
    owners   = state.get('teamOwners', {})
    managers = {m['id']: m['name'] for m in state.get('managers', [])}
    return managers.get(owners.get(code, ''), code)


def _template_comment(r, mgr):
    """Fallback commentary when Groq API is unavailable."""
    l5   = r['l5']
    rank = r['prRank']
    if rank <= 3 and l5['w'] >= 3:
        return (
            f"{mgr} is making a statement at #{rank} — "
            f"{l5['w']}-{l5['l']}-{l5['ot']} in the last five."
        )
    if l5['w'] >= 4:
        return f"Hot streak: {mgr} has gone {l5['w']}-{l5['l']}-{l5['ot']} in their last five."
    if l5['l'] >= 4:
        return (
            f"Rough stretch for {mgr} — "
            f"{l5['w']}-{l5['l']}-{l5['ot']} over the last five is tough to shake."
        )
    return f"{mgr} sits at {r['w']}-{r['l']}-{r['otl']} with {r['pts']} points on the season."


async def _generate_comments(ranked, state):
    """
    Returns {teamCode: comment_str}.
    Uses Groq (llama-3.3-70b) when GROQ_API_KEY is set; falls back to templates.
    """
    def _fallback():
        return {r['code']: _template_comment(r, _mgr_name(state, r['code'])) for r in ranked}

    if not config.GROQ_API_KEY:
        return _fallback()

    lines = []
    for r in ranked:
        mgr  = _mgr_name(state, r['code'])
        l5   = r['l5']
        diff = r['prDiff']
        if diff is None:
            move = 'NEW'
        elif diff > 0:
            move = f'▲{diff}'
        elif diff < 0:
            move = f'▼{abs(diff)}'
        else:
            move = '—'
        lines.append(
            f"#{r['prRank']} ({move}) {r['code']} — mgr: {mgr} | "
            f"{r['w']}-{r['l']}-{r['otl']} {r['pts']}pts | L5: {l5['w']}-{l5['l']}-{l5['ot']}"
        )

    prompt = (
        "You are writing weekly power rankings for a private NHL Legacy (PS3/Xbox 360) video game league. "
        "Write exactly one punchy sentence of commentary per team. "
        "Reference the manager name, their record, and recent form. "
        "Be witty, specific, and use hockey lingo naturally. "
        "Be encouraging for top teams and fair but pointed for struggling ones. "
        "Return ONLY a JSON array, no extra text:\n"
        "[{\"code\": \"TBL\", \"comment\": \"...\"}, ...]\n\n"
        + "\n".join(lines)
    )

    try:
        from groq import AsyncGroq
        client = AsyncGroq(api_key=config.GROQ_API_KEY)
        resp   = await client.chat.completions.create(
            model='llama-3.3-70b-versatile',
            max_tokens=3000,
            messages=[{'role': 'user', 'content': prompt}],
        )
        raw   = resp.choices[0].message.content.strip()
        match = re.search(r'\[.*\]', raw, re.S)
        if match:
            data     = json.loads(match.group())
            comments = {item['code']: item['comment'] for item in data}
            # Fill any teams the model missed with template fallback
            for r in ranked:
                if r['code'] not in comments:
                    comments[r['code']] = _template_comment(r, _mgr_name(state, r['code']))
            return comments
    except Exception as e:
        log.warning(f'Groq API error — falling back to templates: {e}')

    return _fallback()


# ── Embed builders ─────────────────────────────────────────────────────────────

def _move_str(diff):
    if diff is None:
        return '✨'
    if diff > 0:
        return f'▲{diff}'
    if diff < 0:
        return f'▼{abs(diff)}'
    return '━'


def _build_embeds(ranked, comments, state):
    """Return [embed_top10, embed_rest] to send as a single Discord message."""
    league_name = state.get('league', {}).get('name', 'NHL Legacy League')

    # ── Top 10 with AI commentary ──────────────────────────────────────────────
    lines = []
    for r in ranked[:10]:
        code    = r['code']
        mgr     = _mgr_name(state, code)
        l5      = r['l5']
        medal   = MEDALS.get(r['prRank'], f"**{r['prRank']}.**")
        move    = _move_str(r['prDiff'])
        comment = comments.get(code, '')

        header = (
            f"{medal}  {move}  **{code}**"
            + (f"  ·  {mgr}" if mgr else '')
            + f"  —  {r['pts']} pts  |  L5: {l5['w']}-{l5['l']}-{l5['ot']}"
        )
        lines.append(header)
        if comment:
            lines.append(f"> *{comment}*")
        lines.append('')

    ai_note = '✨ Groq AI · llama-3.3-70b' if config.GROQ_API_KEY else '📋 Template rankings'
    embed1  = discord.Embed(
        title=f'📊  {league_name} — Power Rankings',
        description='\n'.join(lines).rstrip(),
        color=SITE_RED,
    )
    embed1.set_footer(text=f'60% recent form · 40% season record  ·  {ai_note}')

    # ── 11-32 compact ──────────────────────────────────────────────────────────
    compact = []
    for r in ranked[10:]:
        code    = r['code']
        mgr     = _mgr_name(state, code)
        l5      = r['l5']
        move    = _move_str(r['prDiff'])
        mgr_str = f' · {mgr}' if mgr else ''
        compact.append(
            f"`{r['prRank']:>2}.`  {move}  **{code}**{mgr_str}"
            f"  —  {r['pts']} pts  |  L5: {l5['w']}-{l5['l']}-{l5['ot']}"
        )

    embed2 = discord.Embed(
        description='\n'.join(compact) if compact else '*No additional teams.*',
        color=SITE_GREY,
    )
    embed2.set_footer(text=f'Full standings → {config.APP_URL}')

    return [embed1, embed2]


# ── State persistence ──────────────────────────────────────────────────────────

async def _save_last_week(state):
    """POST updated state back to server so rank arrows work next week."""
    import aiohttp
    from bot.auth import get_token
    token = get_token()
    if not token:
        log.warning('No admin token — skipping powerRankingsLastWeek save')
        return
    url     = f'{config.API_BASE}/api/state'
    headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=state, headers=headers) as resp:
                if resp.status != 200:
                    log.warning(f'powerRankingsLastWeek save failed: HTTP {resp.status}')
    except Exception as e:
        log.warning(f'powerRankingsLastWeek save error: {e}')


# ── Cog ───────────────────────────────────────────────────────────────────────

class PowerRankingsCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot         = bot
        self._last_posted = ''   # ISO date — prevents double-posting on bot restart
        if config.POWER_RANKINGS_CHANNEL:
            self.weekly_task.start()

    def cog_unload(self):
        self.weekly_task.cancel()

    # ── Scheduled task — fires daily at POWER_RANKINGS_HOUR UTC ───────────────

    @tasks.loop(time=_TASK_TIME)
    async def weekly_task(self):
        now   = datetime.datetime.now(datetime.timezone.utc)
        today = now.strftime('%Y-%m-%d')
        if now.weekday() != config.POWER_RANKINGS_DAY:
            return
        if today == self._last_posted:
            return   # Already posted today (e.g. bot restarted mid-day)
        log.info('Scheduled weekly power rankings firing')
        try:
            await self._post_power_rankings(config.POWER_RANKINGS_CHANNEL)
            self._last_posted = today
        except Exception as e:
            log.error(f'Weekly power rankings error: {e}')

    @weekly_task.before_loop
    async def before_weekly_task(self):
        await self.bot.wait_until_ready()

    # ── /powerrankings command ─────────────────────────────────────────────────

    @app_commands.command(
        name='powerrankings',
        description="[Admin] Post this week's AI power rankings right now",
    )
    async def powerrankings(self, interaction: discord.Interaction):
        from bot.commands.trade import _is_admin
        if not _is_admin(interaction):
            await interaction.response.send_message('🔒 Admin only.', ephemeral=True)
            return

        await interaction.response.defer(thinking=True, ephemeral=True)
        ch_id = config.POWER_RANKINGS_CHANNEL or interaction.channel_id
        try:
            await self._post_power_rankings(ch_id)
            await interaction.followup.send('✅ Power rankings posted!', ephemeral=True)
        except Exception as e:
            log.error(f'/powerrankings error: {e}')
            await interaction.followup.send(f'❌ Error: {e}', ephemeral=True)

    # ── Core logic ─────────────────────────────────────────────────────────────

    async def _post_power_rankings(self, channel_id: int):
        # Resolve channel
        guild = self.bot.get_guild(config.GUILD_ID) if config.GUILD_ID else None
        ch    = guild.get_channel(channel_id) if guild else None
        if not ch:
            ch = await self.bot.fetch_channel(channel_id)
        if not ch:
            log.error(f'Power rankings: channel {channel_id} not found')
            return

        state  = await get_state()
        ranked = _compute_power_rankings(state)

        if not ranked:
            await ch.send('⚠️ No games played yet — power rankings unavailable.')
            return

        comments = await _generate_comments(ranked, state)
        embeds   = _build_embeds(ranked, comments, state)
        await ch.send(embeds=embeds)

        # Persist rank snapshot so next week's arrows are accurate
        state['powerRankingsLastWeek'] = {r['code']: r['prRank'] for r in ranked}
        await _save_last_week(state)
        log.info(f'Power rankings posted to channel {channel_id}')


async def setup(bot: commands.Bot):
    await bot.add_cog(PowerRankingsCog(bot))
