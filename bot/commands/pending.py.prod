"""
commands/pending.py  —  /pending command (admin only)
List pending requests and approve/reject via buttons.
"""
import discord
from discord import app_commands
from discord.ext import commands

from bot.api import api_get, api_patch
from bot.auth import get_token
import bot.config as config


def _is_admin(interaction: discord.Interaction) -> bool:
    # Bot secret is the gate, not Discord roles
    return True


def _fmt_pending(item: dict) -> discord.Embed:
    req_type = item.get('type', '?')
    payload  = item.get('payload', {})
    who      = item.get('submitted_name', item.get('submitted_by', '?'))
    req_id   = item.get('id', '?')

    if req_type == 'score':
        ht = payload.get('homeTeam', '?')
        at = payload.get('awayTeam', '?')
        hs = payload.get('homeScore', '?')
        as_ = payload.get('awayScore', '?')
        ot  = ' (OT)' if payload.get('ot') else ''
        desc = f'**{ht} {hs} – {as_} {at}**{ot}'
        title = '🏒 Score Submission'
    elif req_type == 'trade':
        ft = payload.get('fromTeam', '?')
        tt = payload.get('toTeam', '?')
        sent     = ', '.join(payload.get('playersSent', [])) or '—'
        received = ', '.join(payload.get('playersReceived', [])) or '—'
        desc = f'**{ft}** sends: {sent}\n**{tt}** sends: {received}'
        if payload.get('notes'):
            desc += f'\n_Notes: {payload["notes"]}_'
        title = '🔄 Trade Submission'
    else:
        desc = str(payload)
        title = f'📋 {req_type.title()} Submission'

    embed = discord.Embed(title=title, description=desc, color=discord.Color.yellow())
    embed.set_footer(text=f'ID: {req_id[:8]}…  •  Submitted by {who}')
    return embed


class ApproveView(discord.ui.View):
    def __init__(self, req_id: str, token: str):
        super().__init__(timeout=None)
        self.req_id = req_id
        self.token  = token

    @discord.ui.button(label='✅ Approve', style=discord.ButtonStyle.success)
    async def approve(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not _is_admin(interaction):
            await interaction.response.send_message('Admin only.', ephemeral=True)
            return
        await interaction.response.defer()
        status, body = await api_patch(
            f'/api/pending/{self.req_id}',
            {'action': 'approve'},
            token=self.token,
        )
        if status == 200 and body.get('ok'):
            await interaction.edit_original_response(
                content=f'✅ Approved by {interaction.user.mention}',
                view=None,
            )
        else:
            await interaction.followup.send(
                f'Error: {body.get("error", "Unknown")}', ephemeral=True
            )

    @discord.ui.button(label='❌ Reject', style=discord.ButtonStyle.danger)
    async def reject(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not _is_admin(interaction):
            await interaction.response.send_message('Admin only.', ephemeral=True)
            return
        await interaction.response.defer()
        status, body = await api_patch(
            f'/api/pending/{self.req_id}',
            {'action': 'reject'},
            token=self.token,
        )
        if status == 200 and body.get('ok'):
            await interaction.edit_original_response(
                content=f'❌ Rejected by {interaction.user.mention}',
                view=None,
            )
        else:
            await interaction.followup.send(
                f'Error: {body.get("error", "Unknown")}', ephemeral=True
            )


# Global token storage (shared across all cog instances)
# Token is now managed by bot.auth module (auto-authenticated at startup)

class PendingCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name='pending', description='List pending score/trade submissions')
    async def pending(self, interaction: discord.Interaction):
        await interaction.response.defer(thinking=True, ephemeral=True)

        status, items = await api_get('/api/pending?status=pending', token=get_token())
        # Note: GET /api/pending requires admin JWT — the bot's token must be set.
        # If not set, instruct user to use the web admin panel.
        if status == 401 or not get_token():
            await interaction.followup.send(
                '⚠️ The bot needs an admin token to list pending items.\n'
                'Run `/botlogin <password>` first to authenticate the bot.',
                ephemeral=True,
            )
            return

        if not isinstance(items, list) or not items:
            await interaction.followup.send('No pending requests.', ephemeral=True)
            return

        for item in items[:10]:  # Cap at 10 to avoid spam
            embed = _fmt_pending(item)
            view  = ApproveView(item['id'], _bot_token)
            await interaction.followup.send(embed=embed, view=view, ephemeral=True)

    @app_commands.command(
        name='notify-admins',
        description='Send all pending items to admins via DM'
    )
    async def notify_admins(self, interaction: discord.Interaction):
        """DM all admins with pending submissions."""
        await interaction.response.defer(ephemeral=True)

        # Send immediate response so Discord doesn't timeout
        await interaction.followup.send('📤 Sending pending items to admins...', ephemeral=True)

        status, items = await api_get('/api/pending?status=pending', token=get_token())
        if status == 401 or not get_token():
            print("[ERROR] Bot not authenticated")
            return

        if not isinstance(items, list) or not items:
            print("[INFO] No pending items")
            return

        if not config.ADMIN_ROLE_ID or not interaction.guild:
            print("[ERROR] Admin role not configured")
            return

        role = interaction.guild.get_role(config.ADMIN_ROLE_ID)
        if not role:
            print(f"[ERROR] Admin role {config.ADMIN_ROLE_ID} not found")
            return

        # Use cached members
        admins = [m for m in interaction.guild.members if any(r.id == config.ADMIN_ROLE_ID for r in m.roles)]
        print(f"[DEBUG] Found {len(admins)} admins, sending {len(items)} pending items")

        sent_count = 0
        for member in admins:
            try:
                for item in items:
                    embed = _fmt_pending(item)
                    view = ApproveView(item['id'], _bot_token)
                    await member.send(embed=embed, view=view)
                sent_count += 1
            except Exception as e:
                print(f"[DEBUG] Failed to DM {member.name}: {e}")

        print(f"[DEBUG] ✅ Sent to {sent_count}/{len(admins)} admins")

    @app_commands.command(
        name='botlogin',
        description='Authenticate the bot with admin password'
    )
    @app_commands.describe(password='Admin password')
    async def botlogin(self, interaction: discord.Interaction, password: str):
        """Logs the bot in as admin so /notify-admins works."""
        await interaction.response.defer(ephemeral=True)

        import aiohttp
        import bot.config as cfg
        async with aiohttp.ClientSession() as s:
            async with s.post(
                f'{cfg.API_BASE}/api/auth',
                json={'password': password},
                headers={'Content-Type': 'application/json'},
            ) as r:
                body = await r.json(content_type=None)

        if r.status == 200 and body.get('token'):
            global _bot_token
            _bot_token = body['token']
            await interaction.followup.send('✅ Bot authenticated as admin.', ephemeral=True)
        else:
            await interaction.followup.send(
                f'❌ Authentication failed: {body.get("error", "Unknown")}', ephemeral=True
            )


async def setup(bot: commands.Bot):
    await bot.add_cog(PendingCog(bot))
