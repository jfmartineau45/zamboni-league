"""
commands/standings.py  —  /standings command
Shows top-5 standings teaser + screenshot, links to full site.
"""
import discord
from discord import app_commands
from discord.ext import commands

from bot.api import get_state
from bot import config
from bot.embeds import SITE_RED, _site_button


def _compute_standings(state: dict) -> list[dict]:
    """Return a list of {code, name, w, l, otl, pts, gp, gf, ga} sorted by pts desc."""
    teams  = state.get('teams', [])
    games  = state.get('games', [])

    name_map = {}
    for t in teams:
        code = t.get('code') or t.get('id', '')
        name = t.get('name') or (t.get('city', '') + ' ' + t.get('nick', '')).strip()
        if code:
            name_map[code] = name

    stats: dict[str, dict] = {}

    def _ensure(code):
        if code not in stats:
            stats[code] = {'code': code, 'name': name_map.get(code, code),
                           'w': 0, 'l': 0, 'otl': 0, 'gf': 0, 'ga': 0}

    for g in games:
        if not g.get('played'):
            continue
        ht  = g.get('homeTeam') or g.get('home', '')
        at  = g.get('awayTeam') or g.get('away', '')
        hs  = int(g.get('homeScore', 0))
        as_ = int(g.get('awayScore', 0))
        ot  = bool(g.get('ot'))
        if not ht or not at:
            continue
        _ensure(ht); _ensure(at)
        stats[ht]['gf'] += hs;  stats[ht]['ga'] += as_
        stats[at]['gf'] += as_; stats[at]['ga'] += hs
        if hs > as_:
            stats[ht]['w'] += 1
            stats[at]['otl' if ot else 'l'] += 1
        else:
            stats[at]['w'] += 1
            stats[ht]['otl' if ot else 'l'] += 1

    for s in stats.values():
        s['pts'] = s['w'] * 2 + s['otl']
        s['gp']  = s['w'] + s['l'] + s['otl']

    return sorted(stats.values(), key=lambda x: (-x['pts'], -x['w'], -(x['gf'] - x['ga'])))


def _website_view() -> discord.ui.View:
    view = discord.ui.View()
    view.add_item(discord.ui.Button(
        label='📋 Full Standings',
        style=discord.ButtonStyle.link,
        url=f'{config.APP_URL}/#standings',
    ))
    view.add_item(discord.ui.Button(
        label='🏆 Power Rankings',
        style=discord.ButtonStyle.link,
        url=config.APP_URL,
    ))
    return view


class StandingsCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name='standings', description='Show current league standings (top 5 preview)')
    @app_commands.describe(conference='Filter by conference (East/West) — optional')
    async def standings(self, interaction: discord.Interaction, conference: str = ''):
        await interaction.response.defer(thinking=True)

        state = await get_state()
        if not state:
            await interaction.followup.send('Could not load league data.', ephemeral=True)
            return

        rows = _compute_standings(state)

        if conference:
            conf_filter = conference.strip().upper()
            conf_codes = set()
            for t in state.get('teams', []):
                tc   = (t.get('conference') or '').upper()
                code = t.get('code') or t.get('id', '')
                if conf_filter in tc:
                    conf_codes.add(code)
            rows = [r for r in rows if r['code'] in conf_codes]

        if not rows:
            await interaction.followup.send('No standings data yet.', ephemeral=True)
            return

        league_name = state.get('league', {}).get('name', 'NHL Legacy League')
        owners      = state.get('teamOwners', {})
        managers    = {m['id']: m['name'] for m in state.get('managers', [])}
        played      = sum(1 for g in state.get('games', []) if g.get('played'))
        total_games = len(state.get('games', []))

        title = f'📊  {league_name}'
        if conference:
            title += f'  ·  {conference.title()}'

        embed = discord.Embed(title=title, color=SITE_RED)

        # Top-5 teaser — rank, team, pts only. Full stats live on the site.
        medals = {1: '🥇', 2: '🥈', 3: '🥉'}
        lines  = []
        for i, r in enumerate(rows[:5], 1):
            mgr_id = owners.get(r['code'], '')
            mgr    = managers.get(mgr_id, '')
            medal  = medals.get(i, f'**{i}.**')
            mgr_str = f'  *{mgr}*' if mgr else ''
            lines.append(f"{medal}  **{r['code']}**  —  {r['pts']} pts{mgr_str}")

        if len(rows) > 5:
            lines.append(f'*… and {len(rows) - 5} more teams*')

        embed.description = '\n'.join(lines)
        embed.set_footer(text=f'{played} of {total_games} games played  ·  Full stats on the site')

        await interaction.followup.send(embed=embed, view=_website_view())


async def setup(bot: commands.Bot):
    await bot.add_cog(StandingsCog(bot))
