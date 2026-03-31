"""
commands/score.py  —  /score command
Pick a game from this week's schedule → enter two scores → sent for admin approval.
"""
import discord
from discord import app_commands
from discord.ext import commands

from bot.api import api_post, api_patch, get_state, get_teams
from bot import config
from bot.embeds import score_result_embed, score_pending_embed, _site_button


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

        # Resolve scores channel: prefer state config, fall back to .env
        from bot.api import get_discord_config
        dc = await get_discord_config()
        raw_ch_id = dc.get('scoresChannel') or ''
        try:
            ch_id = int(raw_ch_id) if raw_ch_id.strip() else config.SCORES_CHANNEL
        except (ValueError, AttributeError):
            ch_id = config.SCORES_CHANNEL

        scores_ch = None
        if ch_id:
            # Prefer the guild from the interaction (works in both channel and DM contexts).
            # Fall back to bot cache lookup so DM approvals still work.
            guild = interaction.guild or (
                self.bot_ref.get_guild(config.GUILD_ID) if config.GUILD_ID else None
            )
            scores_ch = guild.get_channel(ch_id) if guild else None

        state    = await get_state()
        # Enrich payload with week number from game record
        game_rec = next((g for g in state.get('games', []) if g['id'] == str(self.payload.get('gameId', ''))), {})
        enriched = {**self.payload, 'week': game_rec.get('week', 1)}

        result_embed = score_result_embed(enriched, state, interaction.user.display_name)

        if scores_ch:
            await scores_ch.send(embed=result_embed, view=_site_button())
        else:
            # No channel configured — log a warning but don't crash
            import logging
            logging.getLogger('nhl-bot').warning(
                f'Score approved but no scores channel configured '
                f'(state scoresChannel={raw_ch_id!r}, .env SCORES_CHANNEL={config.SCORES_CHANNEL})'
            )

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
        g       = next((x for x in state.get('games', []) if x['id'] == str(game)), None)

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

        # Notify admins — via DM and/or pending channel based on config
        from bot.api import get_discord_config
        dc        = await get_discord_config()
        admin_dm  = dc.get('adminDm', True)
        raw_pc_id = dc.get('pendingChannel') or ''
        try:
            pending_ch_id = int(raw_pc_id) if raw_pc_id.strip() else config.PENDING_CHANNEL
        except (ValueError, AttributeError):
            pending_ch_id = config.PENDING_CHANNEL

        pend_state = await get_state()
        pend_embed = score_pending_embed(payload, g, interaction.user.display_name, pend_state)
        view = ScoreApprovalView(req_id, payload, interaction.user.display_name, self.bot)

        # DM each admin
        if admin_dm and config.ADMIN_ROLE_ID and interaction.guild:
            role = interaction.guild.get_role(config.ADMIN_ROLE_ID)
            if role:
                for member in role.members:
                    try:
                        await member.send(embed=pend_embed, view=view)
                    except discord.Forbidden:
                        pass

        # Post to pending channel (if configured)
        if pending_ch_id and config.GUILD_ID and interaction.guild:
            pend_ch = interaction.guild.get_channel(pending_ch_id)
            if pend_ch:
                try:
                    await pend_ch.send(embed=pend_embed, view=view)
                except Exception:
                    pass


async def setup(bot: commands.Bot):
    await bot.add_cog(ScoreCog(bot))
