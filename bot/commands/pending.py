"""
commands/pending.py  —  /pending command (admin only)
List pending requests and approve/reject via buttons.
"""
import discord
from discord import app_commands
from discord.ext import commands

from bot.api import api_get, api_patch
from bot.auth import get_token, set_token
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
    elif req_type == 'linkAccount':
        mgr_name  = payload.get('managerName', payload.get('managerId', '?'))
        disc_user = payload.get('discordUsername', '?')
        disc_id   = payload.get('discordId', '?')
        rpcn      = payload.get('zamboniTag', '?')
        desc  = (
            f'**Manager:** {mgr_name}\n'
            f'**Discord:** {disc_user} (`{disc_id}`)\n'
            f'**RPCN Account:** `{rpcn}`'
        )
        title = '🔗 Account Link Request'
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

    @app_commands.command(
        name='pending',
        description='[Admin] List all pending scores and trades'
    )
    async def pending(self, interaction: discord.Interaction):
        view = discord.ui.View()
        view.add_item(discord.ui.Button(
            label='Open Website Admin',
            style=discord.ButtonStyle.link,
            url=f'{config.APP_URL}/#settings',
        ))
        await interaction.response.send_message(
            '📋 **Pending reviews now belong on the website admin panel.**\n'
            'Use the site to review pending items and manage league operations.',
            view=view,
            ephemeral=True,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(PendingCog(bot))
