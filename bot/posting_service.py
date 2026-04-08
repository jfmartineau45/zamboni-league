"""
posting_service.py — Background job that polls the bot event queue and posts updates
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List

import discord
from discord.ext import tasks

from bot import api, config
from bot.embeds import score_result_embed, trade_result_embed

log = logging.getLogger('nhl-bot')


class PostingService:
    def __init__(self, bot: discord.Client):
        self.bot = bot
        self._poll_interval = 10  # seconds
        self._task = self._poll_events.start()

    def stop(self):
        if self._task.is_running():
            self._task.cancel()

    @tasks.loop(seconds=10)
    async def _poll_events(self):
        await self.bot.wait_until_ready()
        try:
            events = await api.get_bot_events(limit=20)
        except Exception as exc:
            log.warning('Failed to fetch bot events: %s', exc)
            return

        if not events:
            return

        handled_ids: List[int] = []
        for event in events:
            ok = await self._handle_event(event)
            if ok:
                handled_ids.append(event['id'])

        if handled_ids:
            try:
                await api.ack_bot_events(handled_ids, handled_by=config.BOT_ENV or 'bot')
            except Exception as exc:
                log.warning('Failed to ack bot events %s: %s', handled_ids, exc)

    @_poll_events.before_loop
    async def before_poll(self):
        await self.bot.wait_until_ready()

    async def _handle_event(self, event: Dict[str, Any]) -> bool:
        event_type = event.get('eventType')
        payload = event.get('payload') or {}

        if event_type == 'score_final':
            return await self._handle_score_event(payload)
        if event_type == 'trade_final':
            return await self._handle_trade_event(payload)

        log.info('Unhandled bot event type: %s', event_type)
        return False

    async def _handle_score_event(self, payload: Dict[str, Any]) -> bool:
        ch_id = config.SCORES_CHANNEL
        guild = self.bot.get_guild(config.GUILD_ID) if config.GUILD_ID else None
        channel = guild.get_channel(ch_id) if guild and ch_id else None

        if not channel:
            log.warning('Score event received but SCORES_CHANNEL or guild not configured')
            return False

        # Fetch state for manager names (needed for embed helper)
        state = await api.get_state()
        embed = score_result_embed(payload, state, payload.get('approvedBy', 'website'))

        view = discord.ui.View()
        view.add_item(discord.ui.Button(
            label='Open Player Portal',
            style=discord.ButtonStyle.link,
            url=f"{config.APP_URL}/?portal=1",
        ))

        try:
            await channel.send(embed=embed, view=view)
            return True
        except Exception as exc:
            log.warning('Failed to post score event: %s', exc)
            return False

    async def _handle_trade_event(self, payload: Dict[str, Any]) -> bool:
        ch_id = config.TRADES_CHANNEL
        guild = self.bot.get_guild(config.GUILD_ID) if config.GUILD_ID else None
        channel = guild.get_channel(ch_id) if guild and ch_id else None

        log.info('Trade event: guild=%s ch_id=%s channel=%s', guild, ch_id, channel)

        if not channel:
            log.warning('Trade event received but TRADES_CHANNEL or guild not configured')
            return False

        try:
            teams = await api.get_teams()
            log.info('Teams fetched: %s items', len(teams) if teams else 0)
            state = await api.get_state()
            log.info('State fetched: ok=%s', bool(state))
            embed = trade_result_embed(payload, teams, state, payload.get('approvedBy', 'website'))
        except Exception as exc:
            log.warning('Failed to build trade embed: %s', exc, exc_info=True)
            return False

        view = discord.ui.View()
        view.add_item(discord.ui.Button(
            label='Open Trade Hub',
            style=discord.ButtonStyle.link,
            url=f"{config.APP_URL}/#trades",
        ))

        try:
            await channel.send(embed=embed, view=view)
            log.info('Trade embed posted successfully')
            return True
        except Exception as exc:
            log.warning('Failed to post trade event: %s', exc, exc_info=True)
            return False
