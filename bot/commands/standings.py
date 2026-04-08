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
        target = f'{config.APP_URL}/#standings'
        if conference:
            target = f'{config.APP_URL}/#standings'
        view = discord.ui.View()
        view.add_item(discord.ui.Button(
            label='Open Website Standings',
            style=discord.ButtonStyle.link,
            url=target,
        ))
        await interaction.response.send_message(
            '📊 **Standings now live on the website.**\n'
            'Open the site for the full standings table, power rankings, and team stats.',
            view=view,
            ephemeral=True,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(StandingsCog(bot))
