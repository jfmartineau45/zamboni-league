"""
commands/trade.py  —  /trade command (admin only)
Cleaner trade flow: team autocomplete in slash command, then player dropdowns.
"""
import discord
from discord import app_commands
from discord.ext import commands

from bot.api import api_post, get_teams, get_state
from bot import config
from bot.embeds import trade_result_embed, trade_pending_embed, _site_button


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


async def _team_choices(current: str) -> list[app_commands.Choice[str]]:
    teams = await get_teams()
    current_up = current.upper().strip()
    choices = []
    for t in teams:
        code = (t.get('code') or '').upper()
        name = t.get('name') or code
        label = f"{name} ({code})"
        if not current_up or current_up in code or current_up in name.upper():
            choices.append(app_commands.Choice(name=label[:100], value=code))
    return choices[:25]


class TradePlayerSelect(discord.ui.Select):
    def __init__(self, parent_view: 'PlayerSelectView', team_code: str, options: list[discord.SelectOption], kind: str):
        self.parent_view = parent_view
        self.kind = kind
        placeholder = (
            'Select players FROM team is sending...'
            if kind == 'from'
            else 'Select players TO team is sending back...'
        )
        super().__init__(
            placeholder=placeholder,
            options=options,
            min_values=0,
            max_values=min(3, len(options)),
            custom_id=f'trade_players_{kind}_{team_code.lower()}',
        )

    async def callback(self, interaction: discord.Interaction):
        if self.kind == 'from':
            self.parent_view.selected_from_players = list(self.values)
        else:
            self.parent_view.selected_to_players = list(self.values)
        await interaction.response.defer()


# ── Player Selection View ─────────────────────────────────────────────────────

class PlayerSelectView(discord.ui.View):
    def __init__(self, from_team: str, to_team: str, teams: list, state: dict, bot: commands.Bot):
        super().__init__(timeout=600)
        self.from_team = from_team
        self.to_team = to_team
        self.teams = teams
        self.state = state
        self.bot = bot
        self.selected_from_players = []
        self.selected_to_players = []
        
        # Get players for each team
        self.from_team_players = [
            p for p in state.get('players', []) 
            if p.get('teamCode', '').upper() == from_team.upper()
        ]
        self.to_team_players = [
            p for p in state.get('players', []) 
            if p.get('teamCode', '').upper() == to_team.upper()
        ]
        
        # Create player selects
        self._add_player_selects()
        
        # Add submit button
        self.submit_btn = discord.ui.Button(
            label='Submit Trade',
            style=discord.ButtonStyle.success,
            custom_id='submit_trade'
        )
        self.submit_btn.callback = self._submit_trade
        self.add_item(self.submit_btn)
        
        # Add cancel button
        self.cancel_btn = discord.ui.Button(
            label='Cancel',
            style=discord.ButtonStyle.secondary,
            custom_id='cancel_trade'
        )
        self.cancel_btn.callback = self._cancel
        self.add_item(self.cancel_btn)
    
    def _add_player_selects(self):
        # From team players
        if self.from_team_players:
            from_options = [
                discord.SelectOption(
                    label=f"{p['name']} ({p.get('ovr','?')})",
                    value=p['name']
                )
                for p in self.from_team_players[:25]
            ]
            self.add_item(TradePlayerSelect(self, self.from_team, from_options, 'from'))
        
        # To team players
        if self.to_team_players:
            to_options = [
                discord.SelectOption(
                    label=f"{p['name']} ({p.get('ovr','?')})",
                    value=p['name']
                )
                for p in self.to_team_players[:25]
            ]
            self.add_item(TradePlayerSelect(self, self.to_team, to_options, 'to'))
    
    async def _submit_trade(self, interaction: discord.Interaction):
        # Get selected players
        from_players = self.selected_from_players
        to_players = self.selected_to_players
        
        if not from_players and not to_players:
            await interaction.response.send_message(
                'At least one player must be included in the trade.', ephemeral=True
            )
            return
        
        # Create payload
        payload = {
            'fromTeam': self.from_team,
            'toTeam': self.to_team,
            'playersSent': list(from_players),
            'playersReceived': list(to_players),
            'notes': '',  # No notes for simplicity
        }
        
        # Submit trade
        status, body = await api_post('/api/pending', {
            'type': 'trade',
            'payload': payload,
            'submittedBy': str(interaction.user.id),
            'submittedName': interaction.user.display_name,
        })
        
        if status != 200:
            await interaction.response.send_message(
                f"Failed to submit: {body.get('error', 'Unknown')}", ephemeral=True
            )
            return
        
        req_id = body['id']
        embed = trade_pending_embed(payload, self.teams, self.state, interaction.user.display_name, req_id)
        
        # Update message with confirmation
        await interaction.response.edit_message(
            content='✅ **Trade submitted for approval!**',
            embed=embed,
            view=None
        )
        
        # Notify admins
        from bot.api import get_discord_config
        dc = await get_discord_config()
        admin_dm = dc.get('adminDm', True)
        raw_pc_id = dc.get('pendingChannel') or ''
        try:
            pending_ch_id = int(raw_pc_id) if raw_pc_id.strip() else config.PENDING_CHANNEL
        except (ValueError, AttributeError):
            pending_ch_id = config.PENDING_CHANNEL
        
        view = TradeApprovalView(req_id, payload, interaction.user.display_name, self.bot)
        
        # DM each admin
        if admin_dm and config.ADMIN_ROLE_ID and interaction.guild:
            role = interaction.guild.get_role(config.ADMIN_ROLE_ID)
            if role:
                for member in role.members:
                    try:
                        await member.send(
                            content='📥 **New trade pending — click Approve or Reject:**',
                            embed=embed,
                            view=view,
                        )
                    except discord.Forbidden:
                        pass
        
        # Post to pending channel
        if pending_ch_id and interaction.guild:
            pend_ch = interaction.guild.get_channel(pending_ch_id)
            if pend_ch:
                try:
                    await pend_ch.send(
                        content='📥 **New trade pending — click Approve or Reject:**',
                        embed=embed,
                        view=view,
                    )
                except Exception:
                    pass
    
    async def _cancel(self, interaction: discord.Interaction):
        await interaction.response.edit_message(
            content='Trade cancelled.',
            embed=None,
            view=None
        )


# ── Cog ───────────────────────────────────────────────────────────────────────

class TradeCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def _team_ac(self, interaction: discord.Interaction, current: str):
        return await _team_choices(current)

    @app_commands.command(
        name='trade',
        description='[Admin] Record a trade between two teams'
    )
    @app_commands.describe(
        from_team='Team sending players',
        to_team='Team receiving players',
    )
    @app_commands.autocomplete(
        from_team=_team_ac,
        to_team=_team_ac,
    )
    async def trade(self, interaction: discord.Interaction, from_team: str, to_team: str):
        view = discord.ui.View()
        view.add_item(discord.ui.Button(
            label='Open Trade Hub',
            style=discord.ButtonStyle.link,
            url=f'{config.APP_URL}/#trades',
        ))
        await interaction.response.send_message(
            '🔄 **Trade workflows are now website-first.**\n'
            'Use the website trade hub to create, review, and manage trades.',
            view=view,
            ephemeral=True,
        )


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

        # Post to trades channel — prefer state config, fall back to .env
        from bot.api import get_discord_config
        import logging
        log = logging.getLogger('nhl-bot')
        dc = await get_discord_config()
        raw_ch_id = dc.get('tradesChannel') or ''
        try:
            ch_id = int(raw_ch_id) if raw_ch_id.strip() else config.TRADES_CHANNEL
        except (ValueError, AttributeError):
            ch_id = config.TRADES_CHANNEL

        guild = interaction.guild or (
            self.bot_ref.get_guild(config.GUILD_ID) if config.GUILD_ID else None
        )
        ch = guild.get_channel(ch_id) if (guild and ch_id) else None

        if ch:
            teams  = await get_teams()
            state  = await get_state()
            result_embed = trade_result_embed(self.payload, teams, state, interaction.user.display_name)
            try:
                await ch.send(embed=result_embed, view=_site_button())
                log.info(f'Trade posted to channel {ch_id}')
            except Exception as e:
                log.error(f'Failed to post trade to channel {ch_id}: {e}')
        else:
            log.warning(
                f'Trade approved but no trades channel found '
                f'(state tradesChannel={raw_ch_id!r}, .env TRADES_CHANNEL={config.TRADES_CHANNEL})'
            )

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
