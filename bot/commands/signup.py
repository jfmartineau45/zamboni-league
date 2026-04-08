"""
commands/signup.py — website-first /signup command

The Discord bot no longer hosts account linking. Players are directed to the
website portal to sign in with Discord and link their manager account there.
"""
import discord
from discord.ext import commands

import bot.config as config


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

    # DM every admin-role member (only if adminDm is enabled)
    admin_dm_enabled = dc.get('adminDm', True)  # Default to True if not set
    if admin_dm_enabled and config.ADMIN_ROLE_ID and interaction.guild:
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

class SignupPortalView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=120)
        self.add_item(discord.ui.Button(
            label='Open Player Portal',
            style=discord.ButtonStyle.link,
            url=config.APP_URL,
        ))


class SignupCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.command(name='signup')
    async def signup(self, ctx: commands.Context):
        await ctx.reply(
            "🔗 **Account linking is now website-first.**\n"
            "Open the player portal, sign in with Discord, and link your manager"
            " account plus RPCN tag there.",
            view=SignupPortalView(),
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(SignupCog(bot))
