"""
commands/sysdata.py — !rosters command

Points users to the website to download the current league roster file (SYS-DATA).
"""
import discord
from discord.ext import commands

from bot import config


class RostersView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=120)
        self.add_item(discord.ui.Button(
            label='Download Rosters',
            style=discord.ButtonStyle.link,
            url=f"{config.APP_URL}/api/sysdata/download",
        ))


class SysdataCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.command(name='rosters')
    async def rosters(self, ctx: commands.Context):
        """Download the current league roster file."""
        await ctx.reply(
            "📁 **Download the latest league rosters**\n"
            "Click the button below to download the current SYS-DATA file for NHL Legacy.",
            view=RostersView(),
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(SysdataCog(bot))
