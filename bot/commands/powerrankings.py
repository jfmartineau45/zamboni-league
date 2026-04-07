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
            f"Season: {r['w']}-{r['l']}-{r['otl']} ({r['pts']}pts, {r['gp']}GP) | "
            f"GF: {r['gf']} GA: {r['ga']} DIFF: {r['gf']-r['ga']:+d} | "
            f"L5: {l5['w']}-{l5['l']}-{l5['ot']}"
        )

    prompt = (
        "You are Don Cherry — loud, opinionated, old-school hockey guy — writing the weekly power rankings "
        "for a private NHL Legacy (PS3/Xbox 360) video game league. These are real people (the managers) "
        "playing a video game league, so go after them personally by name. No filter, full chirp mode.\n\n"
        "Rules:\n"
        "- Call out managers BY NAME. If they're hot, hype them. If they're cold, bury them.\n"
        "- Top teams: big hype, but remind them it means nothing until the playoffs\n"
        "- Middle of the pack: question their commitment, their strategy, their life choices\n"
        "- Bottom teams: absolutely no mercy — bury them, chirp them, drag them\n"
        "- Use Don Cherry energy: passionate, hyperbolic, old-school hockey references, dramatic\n"
        "- Think: 'I've never seen anything like it', 'gutless', 'beauty', 'what a bum', 'this guy'\n"
        "- Reference their L5 record to call out streaks or collapses specifically\n"
        "- Keep it fun and friendly — no slurs, no genuinely mean-spirited personal attacks — "
        "but roast the HOCKEY, roast the record, roast the decisions\n"
        "- Every comment must feel completely different from the others — vary tone, structure, length\n"
        "- No corporate sports speak whatsoever. Raw. Unfiltered. Don Cherry.\n\n"
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


def _rank_block(ranked_slice, comments, state):
    """Build description lines for a slice of ranked teams — all with commentary."""
    lines = []
    for r in ranked_slice:
        code    = r['code']
        mgr     = _mgr_name(state, code)
        l5      = r['l5']
        medal   = MEDALS.get(r['prRank'], f"`{r['prRank']:>2}.`")
        move    = _move_str(r['prDiff'])
        comment = comments.get(code, '')

        diff_str = f"{r['gf']-r['ga']:+d}"
        header = (
            f"{medal}  {move}  **{code}**"
            + (f"  ·  {mgr}" if mgr else '')
            + f"  —  {r['w']}-{r['l']}-{r['otl']} ({r['pts']}pts)  |  L5: {l5['w']}-{l5['l']}-{l5['ot']}  |  {diff_str}"
        )
        lines.append(header)
        if comment:
            lines.append(f"> *{comment}*")
        lines.append('')
    return '\n'.join(lines).rstrip()


def _build_messages(ranked, comments, state):
    """
    Returns a list of embed lists — one list per Discord message.
    Each message has one embed (10 teams max) to stay under the 6000-char limit.
    """
    league_name = state.get('league', {}).get('name', 'NHL Legacy League')
    ai_note     = '✨ Groq AI · llama-3.3-70b' if config.GROQ_API_KEY else '📋 Template rankings'

    chunks  = [ranked[i:i+10] for i in range(0, len(ranked), 10)]
    messages = []

    for idx, chunk in enumerate(chunks):
        is_first = idx == 0
        is_last  = idx == len(chunks) - 1

        embed = discord.Embed(
            description=_rank_block(chunk, comments, state),
            color=SITE_RED if is_first else SITE_GREY,
        )
        if is_first:
            embed.title = f'📊  {league_name} — Power Rankings'
            embed.set_footer(text=f'60% recent form · 40% season record  ·  {ai_note}')
        if is_last:
            embed.set_footer(text=f'Full standings → {config.APP_URL}')

        messages.append([embed])

    return messages


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
        messages = _build_messages(ranked, comments, state)
        for msg_embeds in messages:
            await ch.send(embeds=msg_embeds)

        # Persist rank snapshot so next week's arrows are accurate
        state['powerRankingsLastWeek'] = {r['code']: r['prRank'] for r in ranked}
        await _save_last_week(state)
        log.info(f'Power rankings posted to channel {channel_id}')


async def setup(bot: commands.Bot):
    await bot.add_cog(PowerRankingsCog(bot))
