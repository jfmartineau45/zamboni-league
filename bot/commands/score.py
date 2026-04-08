"""
commands/score.py — website-first /score command

This command points players to the website portal where all score submissions
now occur.
"""
import discord
from discord.ext import commands

from bot import config


class ScorePortalView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=120)
        self.add_item(discord.ui.Button(
            label='Open Player Portal',
            style=discord.ButtonStyle.link,
            url=config.APP_URL,
        ))


class ScoreCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.command(name='score')
    async def score(self, ctx: commands.Context):
        await ctx.reply(
            "🏒 **Score submissions now live on the website.**\n"
            "Sign in with Discord, pick your eligible game, match the Zamboni result,"
            " and submit in seconds via the player portal.",
            view=ScorePortalView(),
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(ScoreCog(bot))
