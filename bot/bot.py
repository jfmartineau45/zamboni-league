"""
bot.py — NHL Legacy League Discord Bot
Run from roster-app/ directory:
    python -m bot.bot
or:
    python bot/bot.py
"""
import sys
import os
import asyncio
import logging

import discord
from discord.ext import commands

# Allow running from roster-app/ or from inside bot/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bot.config import DISCORD_TOKEN, GUILD_ID, ADMIN_PASSWORD
from bot import auth

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s %(name)s: %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('nhl-bot')

EXTENSIONS = [
    'bot.commands.score',
    'bot.commands.trade',
    'bot.commands.standings',
    'bot.commands.pending',
]


class NHLBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.members = True  # Required to fetch guild members
        super().__init__(command_prefix='!', intents=intents)

    async def setup_hook(self):
        # Authenticate bot with admin password at startup
        if ADMIN_PASSWORD:
            from bot.api import api_post
            status, body = await api_post('/api/auth', {'password': ADMIN_PASSWORD}, bot_auth=False)
            if status == 200 and 'token' in body:
                auth.set_token(body['token'])
                log.info('Bot authenticated with admin token')
            else:
                log.warning(f'Failed to authenticate bot: {body.get("error", "Unknown error")}')
        else:
            log.warning('ADMIN_PASSWORD not set - bot will use bot secret for auth only')

        for ext in EXTENSIONS:
            await self.load_extension(ext)
            log.info(f'Loaded {ext}')

        # Sync slash commands to guild (instant) or globally (up to 1h delay)
        if GUILD_ID:
            guild = discord.Object(id=GUILD_ID)
            self.tree.copy_global_to(guild=guild)
            synced = await self.tree.sync(guild=guild)
            log.info(f'Synced {len(synced)} command(s) to guild {GUILD_ID}')
        else:
            synced = await self.tree.sync()
            log.info(f'Synced {len(synced)} command(s) globally')

    async def on_ready(self):
        log.info(f'Logged in as {self.user} (id={self.user.id})')
        await self.change_presence(
            activity=discord.Activity(
                type=discord.ActivityType.watching,
                name='the NHL Legacy League'
            )
        )


def main():
    if not DISCORD_TOKEN:
        log.error(
            'DISCORD_TOKEN is not set.\n'
            'Copy bot/.env.example to bot/.env and fill in your token.'
        )
        sys.exit(1)

    bot = NHLBot()
    bot.run(DISCORD_TOKEN, log_handler=None)


if __name__ == '__main__':
    main()
