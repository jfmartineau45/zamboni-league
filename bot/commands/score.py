"""
commands/score.py  —  /score command
Pick a game from this week's schedule → enter two scores → sent for admin approval.
"""
import discord
from discord import app_commands
from discord.ext import commands

from bot.api import api_post, api_patch, get_state, get_teams
from bot import config
from bot.screenshot import capture


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_admin(interaction: discord.Interaction) -> bool:
    if not config.ADMIN_ROLE_ID:
        return True
    if not interaction.guild:
        return False
    member = interaction.guild.get_member(interaction.user.id)
    return member and any(r.id == config.ADMIN_ROLE_ID for r in member.roles)


def _current_week(games: list) -> int:
    """Return the lowest week number that still has unplayed games."""
    weeks = [g['week'] for g in games if not g.get('played')]
    return min(weeks) if weeks else 1


def _website_view() -> discord.ui.View:
    view = discord.ui.View()
    view.add_item(discord.ui.Button(
        label='📊 Full Standings & Stats',
        style=discord.ButtonStyle.link,
        url=config.APP_URL,
    ))
    return view


# ── Approval buttons ──────────────────────────────────────────────────────────

class ScoreApprovalView(discord.ui.View):
    def __init__(self, req_id: str, payload: dict, submitter: str, bot_ref: commands.Bot):
        super().__init__(timeout=None)
        self.req_id    = req_id
        self.payload   = payload
        self.submitter = submitter
        self.bot_ref   = bot_ref

    @discord.ui.button(label='✅ Approve', style=discord.ButtonStyle.success)
    async def approve(self, interaction: discord.Interaction, button: discord.ui.Button):
        # Note: Button only sent to admins via DM, so no role check needed here
        await interaction.response.defer()

        from bot.auth import get_token
        status, body = await api_patch(
            f'/api/pending/{self.req_id}',
            {'action': 'approve'},
            token=get_token(),
        )
        if status != 200 or not body.get('ok'):
            await interaction.followup.send(f"Error: {body.get('error', '?')}", ephemeral=True)
            return

        await interaction.edit_original_response(
            content=f'✅ **Approved** by {interaction.user.mention}',
            view=None,
        )

        # Post result to scores channel
        # Note: Button is clicked in DM, so we need to find guild via bot
        p    = self.payload
        ot   = ' (OT)' if p.get('ot') else ''
        line = f"**{p['homeTeam']} {p['homeScore']} – {p['awayScore']} {p['awayTeam']}**{ot}"

        screenshot = await capture('standings')
        scores_ch  = None
        if config.SCORES_CHANNEL and config.GUILD_ID:
            guild = self.bot_ref.get_guild(config.GUILD_ID) if hasattr(self, 'bot_ref') else None
            scores_ch = guild.get_channel(config.SCORES_CHANNEL) if guild else None

        target = scores_ch or interaction.channel
        if screenshot:
            await target.send(file=screenshot, view=_website_view())
        else:
            embed = discord.Embed(title='🏒 Game Result', description=line, color=discord.Color.blue())
            embed.set_footer(text=f'Submitted by {self.submitter}  •  See full stats on the site')
            await target.send(embed=embed, view=_website_view())

    @discord.ui.button(label='❌ Reject', style=discord.ButtonStyle.danger)
    async def reject(self, interaction: discord.Interaction, button: discord.ui.Button):
        # Note: Button only sent to admins via DM, so no role check needed here
        await interaction.response.defer()

        from bot.auth import get_token
        status, body = await api_patch(
            f'/api/pending/{self.req_id}',
            {'action': 'reject'},
            token=get_token(),
        )
        if status == 200 and body.get('ok'):
            await interaction.edit_original_response(
                content=f'❌ **Rejected** by {interaction.user.mention}',
                view=None,
            )
        else:
            await interaction.followup.send(f"Error: {body.get('error', '?')}", ephemeral=True)


# ── Cog ───────────────────────────────────────────────────────────────────────

class ScoreCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def _game_autocomplete(self, interaction: discord.Interaction, current: str):
        """Show this week's unplayed games as choices."""
        state   = await get_state()
        games   = state.get('games', [])
        week    = _current_week(games)
        current_up = current.upper()
        choices = []
        for g in games:
            if g.get('played') or g.get('week') != week:
                continue
            ht    = g.get('homeTeam', '')
            at    = g.get('awayTeam', '')
            label = f"{ht} vs {at}  (Week {week})"
            if not current_up or current_up in ht.upper() or current_up in at.upper():
                choices.append(app_commands.Choice(name=label, value=g['id']))
        return choices[:25]

    @app_commands.command(
        name='score',
        description='Submit a game result for this week'
    )
    @app_commands.describe(
        game       = "Pick the game from this week's schedule",
        home_score = 'Home team score',
        away_score = 'Away team score',
        overtime   = 'Overtime or shootout? (default: No)',
    )
    @app_commands.autocomplete(game=_game_autocomplete)
    async def score(
        self,
        interaction: discord.Interaction,
        game:        str,
        home_score:  int,
        away_score:  int,
        overtime:    bool = False,
    ):
        await interaction.response.defer(thinking=True, ephemeral=True)

        if home_score == away_score:
            await interaction.followup.send(
                'Scores cannot be tied — every NHL game has a winner.', ephemeral=True
            )
            return

        # Look up the game by ID
        state   = await get_state()
        g       = next((x for x in state.get('games', []) if x['id'] == game), None)

        if not g:
            await interaction.followup.send('Game not found. Try again.', ephemeral=True)
            return
        if g.get('played'):
            await interaction.followup.send(
                f"**{g['homeTeam']} vs {g['awayTeam']}** is already recorded.", ephemeral=True
            )
            return

        payload = {
            'gameId':    g['id'],
            'homeTeam':  g['homeTeam'],
            'awayTeam':  g['awayTeam'],
            'homeScore': home_score,
            'awayScore': away_score,
            'ot':        overtime,
        }

        status, body = await api_post('/api/pending', {
            'type':          'score',
            'payload':       payload,
            'submittedBy':   str(interaction.user.id),
            'submittedName': interaction.user.display_name,
        })

        if status != 200:
            await interaction.followup.send(
                f"Submit failed: {body.get('error', '?')}", ephemeral=True
            )
            return

        req_id = body['id']
        ot_tag = ' (OT)' if overtime else ''

        # Confirm to submitter (only they see this)
        await interaction.followup.send(
            f"✅ **{g['homeTeam']} {home_score} – {away_score} {g['awayTeam']}**{ot_tag}\n"
            f"Submitted! Waiting for admin approval.",
            ephemeral=True,
        )

        # DM all admins with approval buttons
        if config.ADMIN_ROLE_ID and interaction.guild:
            role = interaction.guild.get_role(config.ADMIN_ROLE_ID)
            if role:
                embed = discord.Embed(
                    title='📥 Score Pending Approval',
                    description=f"**{g['homeTeam']} {home_score} – {away_score} {g['awayTeam']}**{ot_tag}",
                    color=discord.Color.orange(),
                )
                embed.set_footer(text=f'Week {g["week"]}  •  Submitted by {interaction.user.display_name}')
                view = ScoreApprovalView(req_id, payload, interaction.user.display_name, self.bot)
                for member in role.members:
                    try:
                        await member.send(embed=embed, view=view)
                    except discord.Forbidden:
                        pass


async def setup(bot: commands.Bot):
    await bot.add_cog(ScoreCog(bot))
