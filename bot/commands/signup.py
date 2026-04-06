"""
commands/signup.py — /signup command
Lets players self-register their Discord account + RPCN Account.

Flow:
  Step 1: Select "Who are you?" dropdown (managers without discordId, or yourself)
  Step 2: Modal — enter RPCN Account (only thing the player types)
  Step 3: POST linkAccount → admin approves → discordId + zamboniTag saved
"""
import logging

import discord
from discord import app_commands
from discord.ext import commands

from bot.api import api_get, api_post, api_patch, get_state, get_discord_config
from bot.auth import get_token
import bot.config as config

log = logging.getLogger('nhl-bot')

GOLD = discord.Color.from_rgb(200, 168, 78)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _unlinked_managers(state: dict, discord_id: str) -> list[dict]:
    """Managers with no discordId, PLUS the current user themselves (allow re-link)."""
    return [
        m for m in state.get('managers', [])
        if not m.get('discordId') or str(m.get('discordId', '')) == discord_id
    ]


async def _validate_rpcn(tag: str) -> bool | None:
    """
    Check tag against /api/zamboni/players.
    Returns True if found, False if not found, None if API is unavailable.
    """
    status, data = await api_get('/api/zamboni/players')
    if status != 200 or not isinstance(data, list):
        return None
    known = set()
    for p in data:
        if isinstance(p, str):
            known.add(p.lower())
        elif isinstance(p, dict):
            t = p.get('gamertag') or p.get('name') or ''
            if t:
                known.add(t.lower())
    return tag.strip().lower() in known


def _signup_embed(mgr_name: str, discord_user: str, rpcn: str, req_id: str) -> discord.Embed:
    embed = discord.Embed(
        title='🔗 Account Link Request',
        color=GOLD,
    )
    embed.add_field(name='Manager', value=mgr_name, inline=True)
    embed.add_field(name='Discord', value=discord_user, inline=True)
    embed.add_field(name='RPCN Account', value=f'`{rpcn}`', inline=True)
    embed.set_footer(text=f'ID: {req_id[:8]}…')
    return embed


# ── Admin approval view ───────────────────────────────────────────────────────

class SignupApprovalView(discord.ui.View):
    def __init__(self, req_id: str):
        super().__init__(timeout=None)
        self.req_id = req_id

    @discord.ui.button(label='✅ Approve', style=discord.ButtonStyle.success)
    async def approve(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        status, body = await api_patch(
            f'/api/pending/{self.req_id}',
            {'action': 'approve'},
            token=get_token(),
        )
        if status == 200 and body.get('ok'):
            await interaction.edit_original_response(
                content=f'✅ Approved by {interaction.user.mention}',
                view=None,
            )
        else:
            await interaction.followup.send(
                f"Error: {body.get('error', '?')}", ephemeral=True
            )

    @discord.ui.button(label='❌ Reject', style=discord.ButtonStyle.danger)
    async def reject(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        status, body = await api_patch(
            f'/api/pending/{self.req_id}',
            {'action': 'reject'},
            token=get_token(),
        )
        if status == 200 and body.get('ok'):
            await interaction.edit_original_response(
                content=f'❌ Rejected by {interaction.user.mention}',
                view=None,
            )
        else:
            await interaction.followup.send(
                f"Error: {body.get('error', '?')}", ephemeral=True
            )


# ── Notify admins ─────────────────────────────────────────────────────────────

async def _notify_admins_signup(
    bot_ref: commands.Bot,
    interaction: discord.Interaction,
    req_id: str,
    mgr_name: str,
    rpcn: str,
):
    dc = await get_discord_config()
    raw_pc_id = dc.get('pendingChannel') or ''
    try:
        pending_ch_id = int(raw_pc_id) if str(raw_pc_id).strip() else config.PENDING_CHANNEL
    except (ValueError, AttributeError):
        pending_ch_id = config.PENDING_CHANNEL

    embed = _signup_embed(
        mgr_name,
        f'{interaction.user.display_name} ({interaction.user.name})',
        rpcn,
        req_id,
    )
    view = SignupApprovalView(req_id)

    # DM every admin-role member
    if config.ADMIN_ROLE_ID and interaction.guild:
        role = interaction.guild.get_role(config.ADMIN_ROLE_ID)
        if role:
            for member in role.members:
                try:
                    await member.send(embed=embed, view=view)
                except discord.Forbidden:
                    pass

    # Post to pending channel
    if pending_ch_id and interaction.guild:
        ch = interaction.guild.get_channel(pending_ch_id)
        if ch:
            try:
                await ch.send(embed=embed, view=view)
            except Exception:
                pass


# ── Submit helper ─────────────────────────────────────────────────────────────

async def _submit_signup(
    interaction: discord.Interaction,
    manager: dict,
    rpcn: str,
    bot_ref: commands.Bot,
):
    payload = {
        'managerId':       manager['id'],
        'managerName':     manager['name'],
        'discordId':       str(interaction.user.id),
        'discordUsername': interaction.user.name,
        'zamboniTag':      rpcn.strip(),
    }
    status, body = await api_post('/api/pending', {
        'type':          'linkAccount',
        'payload':       payload,
        'submittedBy':   str(interaction.user.id),
        'submittedName': interaction.user.display_name,
    })
    if status != 200:
        await interaction.followup.send(
            f"❌ Submission failed: {body.get('error', 'Unknown error')}",
            ephemeral=True,
        )
        return

    req_id = body['id']
    await interaction.followup.send(
        f"✅ **{manager['name']}** linked as `{rpcn.strip()}`\n"
        f"Waiting for admin approval — you'll be able to use `/score` once approved.",
        ephemeral=True,
    )
    await _notify_admins_signup(bot_ref, interaction, req_id, manager['name'], rpcn.strip())


# ── Step 2: RPCN Account modal ────────────────────────────────────────────────

class RPCNModal(discord.ui.Modal):
    def __init__(self, manager: dict, bot_ref: commands.Bot):
        super().__init__(title=f'Sign Up — {manager["name"]}')
        self.manager = manager
        self.bot_ref = bot_ref
        self.rpcn_input = discord.ui.TextInput(
            label='RPCN Account',
            placeholder='e.g. HockeyKing99 (your PS3 Network username)',
            min_length=2,
            max_length=64,
        )
        self.add_item(self.rpcn_input)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        rpcn = self.rpcn_input.value.strip()

        valid = await _validate_rpcn(rpcn)

        if valid is False:
            await interaction.followup.send(
                f"❌ **`{rpcn}`** was not found in the Zamboni player directory.\n"
                f"Double-check the spelling (it's case-sensitive) and try `/signup` again.",
                ephemeral=True,
            )
            return

        if valid is None:
            # Zamboni API unreachable — offer soft submit
            view = SoftSubmitView(self.manager, rpcn, self.bot_ref)
            await interaction.followup.send(
                f"⚠️ Zamboni API is unreachable — **`{rpcn}`** could not be validated.\n"
                f"You can submit anyway and the admin will verify it, or cancel.",
                view=view,
                ephemeral=True,
            )
            return

        await _submit_signup(interaction, self.manager, rpcn, self.bot_ref)


# ── Soft-submit confirm (when Zamboni API is down) ────────────────────────────

class SoftSubmitView(discord.ui.View):
    def __init__(self, manager: dict, rpcn: str, bot_ref: commands.Bot):
        super().__init__(timeout=120)
        self.manager = manager
        self.rpcn    = rpcn
        self.bot_ref = bot_ref

    @discord.ui.button(label='Submit anyway', style=discord.ButtonStyle.primary)
    async def submit(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True)
        await _submit_signup(interaction, self.manager, self.rpcn, self.bot_ref)
        self.stop()

    @discord.ui.button(label='Cancel', style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(content='Signup cancelled.', view=None)
        self.stop()


# ── Step 1: Manager select ────────────────────────────────────────────────────

class ManagerSelect(discord.ui.Select):
    def __init__(self, managers: list[dict], bot_ref: commands.Bot):
        self.mgr_map = {m['id']: m for m in managers}
        self.bot_ref = bot_ref
        options = [
            discord.SelectOption(label=m['name'], value=m['id'])
            for m in managers[:25]
        ]
        super().__init__(
            placeholder='Select your manager name…',
            options=options,
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        manager = self.mgr_map.get(self.values[0])
        if not manager:
            await interaction.response.send_message('Manager not found. Try again.', ephemeral=True)
            return
        await interaction.response.send_modal(RPCNModal(manager, self.bot_ref))


class ManagerSelectView(discord.ui.View):
    def __init__(self, managers: list[dict], bot_ref: commands.Bot):
        super().__init__(timeout=120)
        self.add_item(ManagerSelect(managers, bot_ref))


# ── Cog ───────────────────────────────────────────────────────────────────────

class SignupCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(
        name='signup',
        description='Link your Discord account and RPCN Account to the league',
    )
    async def signup(self, interaction: discord.Interaction):
        await interaction.response.defer(thinking=True, ephemeral=True)

        state = await get_state()
        if not state:
            await interaction.followup.send(
                '❌ Could not reach the league server. Try again later.', ephemeral=True
            )
            return

        discord_id = str(interaction.user.id)
        managers = _unlinked_managers(state, discord_id)

        if not managers:
            await interaction.followup.send(
                '✅ All managers are already linked.\n'
                'If you need to update your RPCN Account, contact the admin.',
                ephemeral=True,
            )
            return

        truncated = len(managers) > 25
        view = ManagerSelectView(managers, self.bot)
        note = (
            '\n*More than 25 managers available — if your name isn\'t listed, ask the admin to add it manually.*'
            if truncated else ''
        )
        await interaction.followup.send(
            f'**Who are you?** Pick your manager name below:{note}',
            view=view,
            ephemeral=True,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(SignupCog(bot))
