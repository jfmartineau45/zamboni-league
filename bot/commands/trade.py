"""
commands/trade.py  —  /trade command (admin only)
All inputs are autocomplete dropdowns — no free-text typing needed.
Up to 3 players per side. Submitted trade goes to pending queue for review.
"""
import discord
from discord import app_commands
from discord.ext import commands

from bot.api import api_post, get_teams, get_state
from bot import config


# ── Admin check ───────────────────────────────────────────────────────────────

def _is_admin(interaction: discord.Interaction) -> bool:
    if not config.ADMIN_ROLE_ID:
        return True
    if not interaction.guild:
        return False
    member = interaction.guild.get_member(interaction.user.id)
    if not member:
        return False
    return any(r.id == config.ADMIN_ROLE_ID for r in member.roles)


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _team_choices(current: str) -> list[app_commands.Choice]:
    teams = await get_teams()
    current_up = current.upper()
    choices = []
    for t in teams:
        code = t.get('code', '')
        name = t.get('name', code)
        label = f"{name} ({code})"
        if not current_up or current_up in code.upper() or current_up in name.upper():
            choices.append(app_commands.Choice(name=label[:100], value=code))
    return choices[:25]


async def _player_choices(current: str, team_code: str) -> list[app_commands.Choice]:
    """Return players on the given team, filtered by current search string."""
    if not team_code:
        return []
    state = await get_state()
    players = state.get('players', [])
    team_up = team_code.upper()
    current_up = current.upper()
    choices = []
    for p in players:
        if (p.get('teamCode') or '').upper() != team_up:
            continue
        name = p.get('name', '')
        ovr  = p.get('ovr', '')
        label = f"{name}  {ovr}" if ovr else name
        if not current_up or current_up in name.upper():
            choices.append(app_commands.Choice(name=label[:100], value=name))
    return choices[:25]


def _name_for(code: str, teams: list[dict]) -> str:
    t = next((x for x in teams if x.get('code', '').upper() == code.upper()), None)
    return t['name'] if t else code


def _website_view() -> discord.ui.View:
    view = discord.ui.View()
    view.add_item(discord.ui.Button(
        label='🔄 Trade Wire',
        style=discord.ButtonStyle.link,
        url=config.APP_URL,
    ))
    return view


# ── Cog ───────────────────────────────────────────────────────────────────────

class TradeCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # Team autocomplete (shared)
    async def _team_ac(self, interaction: discord.Interaction, current: str):
        return await _team_choices(current)

    # Player autocomplete — reads the already-selected team from the namespace
    async def _from_player_ac(self, interaction: discord.Interaction, current: str):
        team = getattr(interaction.namespace, 'from_team', '') or ''
        return await _player_choices(current, team)

    async def _to_player_ac(self, interaction: discord.Interaction, current: str):
        team = getattr(interaction.namespace, 'to_team', '') or ''
        return await _player_choices(current, team)

    @app_commands.command(
        name='trade',
        description='[Admin] Record a trade between two teams'
    )
    @app_commands.describe(
        from_team   = 'Team sending players  →',
        to_team     = 'Team receiving / sending back  →',
        from_p1     = 'Player sent by FROM team',
        from_p2     = 'Player sent by FROM team (optional)',
        from_p3     = 'Player sent by FROM team (optional)',
        to_p1       = 'Player sent by TO team (optional)',
        to_p2       = 'Player sent by TO team (optional)',
        to_p3       = 'Player sent by TO team (optional)',
        notes       = 'Optional note (e.g. "future considerations")',
    )
    @app_commands.autocomplete(
        from_team=_team_ac,
        to_team=_team_ac,
        from_p1=_from_player_ac,
        from_p2=_from_player_ac,
        from_p3=_from_player_ac,
        to_p1=_to_player_ac,
        to_p2=_to_player_ac,
        to_p3=_to_player_ac,
    )
    async def trade(
        self,
        interaction: discord.Interaction,
        from_team: str,
        to_team:   str,
        from_p1:   str,
        from_p2:   str = '',
        from_p3:   str = '',
        to_p1:     str = '',
        to_p2:     str = '',
        to_p3:     str = '',
        notes:     str = '',
    ):
        if not _is_admin(interaction):
            await interaction.response.send_message(
                '🔒 Trade entry is admin-only.', ephemeral=True
            )
            return

        await interaction.response.defer(thinking=True, ephemeral=True)

        from_code = from_team.upper()
        to_code   = to_team.upper()

        if from_code == to_code:
            await interaction.followup.send('From and To teams must be different.', ephemeral=True)
            return

        players_sent     = [p for p in [from_p1, from_p2, from_p3] if p.strip()]
        players_received = [p for p in [to_p1, to_p2, to_p3] if p.strip()]

        if not players_sent and not players_received:
            await interaction.followup.send(
                'At least one player must be included.', ephemeral=True
            )
            return

        payload = {
            'fromTeam':        from_code,
            'toTeam':          to_code,
            'playersSent':     players_sent,
            'playersReceived': players_received,
            'notes':           notes.strip(),
        }

        status, body = await api_post('/api/pending', {
            'type':          'trade',
            'payload':       payload,
            'submittedBy':   str(interaction.user.id),
            'submittedName': interaction.user.display_name,
        })

        if status != 200:
            await interaction.followup.send(
                f"Failed to submit: {body.get('error', 'Unknown')}", ephemeral=True
            )
            return

        req_id = body['id']
        teams  = await get_teams()
        from_name = _name_for(from_code, teams)
        to_name   = _name_for(to_code, teams)

        embed = discord.Embed(
            title='🔄 Trade Submitted — Pending Review',
            color=discord.Color.orange(),
        )
        embed.add_field(
            name=f'{from_name} sends',
            value='\n'.join(f'• {p}' for p in players_sent) or '—',
            inline=True,
        )
        embed.add_field(
            name=f'{to_name} sends',
            value='\n'.join(f'• {p}' for p in players_received) or '—',
            inline=True,
        )
        if notes.strip():
            embed.add_field(name='Notes', value=notes.strip(), inline=False)
        embed.set_footer(text=f'ID: {req_id[:8]}…  •  By {interaction.user.display_name}')

        # Confirm to admin submitter
        await interaction.followup.send(embed=embed, ephemeral=True)

        # DM all admins with approval buttons
        if config.ADMIN_ROLE_ID and interaction.guild:
            role = interaction.guild.get_role(config.ADMIN_ROLE_ID)
            if role:
                view = TradeApprovalView(req_id, payload, interaction.user.display_name, self.bot)
                for member in role.members:
                    try:
                        await member.send(
                            content='📥 **New trade pending — click Approve or Reject:**',
                            embed=embed,
                            view=view,
                        )
                    except discord.Forbidden:
                        pass


# ── Approval view (posted to pending channel) ─────────────────────────────────

class TradeApprovalView(discord.ui.View):
    def __init__(self, req_id: str, payload: dict, submitter: str, bot: commands.Bot = None):
        super().__init__(timeout=None)
        self.req_id    = req_id
        self.payload   = payload
        self.submitter = submitter
        self.bot_ref   = bot

    @discord.ui.button(label='✅ Approve', style=discord.ButtonStyle.success)
    async def approve(self, interaction: discord.Interaction, button: discord.ui.Button):
        # Note: Button only sent to admins via DM, so no role check needed here
        await interaction.response.defer()

        from bot.api import api_patch
        from bot.auth import get_token
        status, body = await api_patch(
            f'/api/pending/{self.req_id}',
            {'action': 'approve'},
            token=get_token(),
        )
        if status != 200 or not body.get('ok'):
            await interaction.followup.send(
                f"Error: {body.get('error', 'Unknown')}", ephemeral=True
            )
            return

        await interaction.edit_original_response(
            content=f'✅ **Trade approved** by {interaction.user.mention}',
            view=None,
        )

        # Post to trades channel
        # Note: Button is clicked in DM, so we need to find guild via bot
        if config.TRADES_CHANNEL and config.GUILD_ID:
            guild = self.bot_ref.get_guild(config.GUILD_ID) if hasattr(self, 'bot_ref') else None
            print(f"[DEBUG] Guild lookup: GUILD_ID={config.GUILD_ID}, found={guild is not None}")
            ch = guild.get_channel(config.TRADES_CHANNEL) if guild else None
            print(f"[DEBUG] Channel lookup: TRADES_CHANNEL={config.TRADES_CHANNEL}, found={ch is not None}")
            if ch:
                teams = await get_teams()
                from_name = _name_for(self.payload['fromTeam'], teams)
                to_name   = _name_for(self.payload['toTeam'], teams)
                result_embed = discord.Embed(title='🔄 Trade Processed', color=discord.Color.green())
                result_embed.add_field(
                    name=f'{from_name} sends',
                    value='\n'.join(f'• {p}' for p in self.payload.get('playersSent', [])) or '—',
                    inline=True,
                )
                result_embed.add_field(
                    name=f'{to_name} sends',
                    value='\n'.join(f'• {p}' for p in self.payload.get('playersReceived', [])) or '—',
                    inline=True,
                )
                if self.payload.get('notes'):
                    result_embed.add_field(name='Notes', value=self.payload['notes'], inline=False)
                result_embed.add_field(
                    name='\u200b',
                    value=f'_See the full Trade Wire at [the league site]({config.APP_URL})_',
                    inline=False,
                )
                result_embed.set_footer(text=f'Approved by {interaction.user.display_name}')
                try:
                    await ch.send(embed=result_embed, view=_website_view())
                    print(f"[DEBUG] Trade posted to channel {config.TRADES_CHANNEL}")
                except Exception as e:
                    print(f"[ERROR] Failed to post trade to channel: {e}")

    @discord.ui.button(label='❌ Reject', style=discord.ButtonStyle.danger)
    async def reject(self, interaction: discord.Interaction, button: discord.ui.Button):
        # Note: Button only sent to admins via DM, so no role check needed here
        await interaction.response.defer()

        from bot.api import api_patch
        from bot.auth import get_token
        status, body = await api_patch(
            f'/api/pending/{self.req_id}',
            {'action': 'reject'},
            token=get_token(),
        )
        if status == 200 and body.get('ok'):
            await interaction.edit_original_response(
                content=f'❌ **Trade rejected** by {interaction.user.mention}',
                view=None,
            )
        else:
            await interaction.followup.send(
                f"Error: {body.get('error', 'Unknown')}", ephemeral=True
            )


async def setup(bot: commands.Bot):
    await bot.add_cog(TradeCog(bot))
