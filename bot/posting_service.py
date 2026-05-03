"""
posting_service.py — Background job that polls the bot event queue and posts updates
"""
from __future__ import annotations

import asyncio
import logging
from typing import Dict, Any, List
from discord.ext import tasks
import discord
import aiohttp
import random

from bot import api, config
from bot.embeds import score_result_embed, trade_result_embed

log = logging.getLogger('nhl-bot')

# Tenor API key (free tier)
TENOR_API_KEY = "AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ"  # Public key for testing

async def get_team_gif(team_code: str) -> str | None:
    """Fetch a random NHL team GIF from Tenor"""
    
    # Map team codes to full team names for better GIF search results
    team_names = {
        'ANA': 'Anaheim Ducks', 'BOS': 'Boston Bruins', 'BUF': 'Buffalo Sabres',
        'CAR': 'Carolina Hurricanes', 'CBJ': 'Columbus Blue Jackets', 'CGY': 'Calgary Flames',
        'CHI': 'Chicago Blackhawks', 'COL': 'Colorado Avalanche', 'DAL': 'Dallas Stars',
        'DET': 'Detroit Red Wings', 'EDM': 'Edmonton Oilers', 'FLA': 'Florida Panthers',
        'LAK': 'Los Angeles Kings', 'MIN': 'Minnesota Wild', 'MTL': 'Montreal Canadiens',
        'NJD': 'New Jersey Devils', 'NSH': 'Nashville Predators', 'NYI': 'New York Islanders',
        'NYR': 'New York Rangers', 'OTT': 'Ottawa Senators', 'PHI': 'Philadelphia Flyers',
        'PIT': 'Pittsburgh Penguins', 'SEA': 'Seattle Kraken', 'SJS': 'San Jose Sharks',
        'STL': 'St Louis Blues', 'TBL': 'Tampa Bay Lightning', 'TOR': 'Toronto Maple Leafs',
        'UTA': 'Utah Hockey Club', 'VAN': 'Vancouver Canucks', 'VGK': 'Vegas Golden Knights',
        'WPG': 'Winnipeg Jets', 'WSH': 'Washington Capitals'
    }
    
    try:
        team_name = team_names.get(team_code, team_code)
        
        # Try multiple search strategies for better results
        search_terms = [
            f"{team_name} goal",           # Team goal celebrations
            f"{team_name} celebration",    # General celebrations
            f"{team_name} hockey"          # Fallback
        ]
        
        for search_term in search_terms:
            url = f"https://tenor.googleapis.com/v2/search?q={search_term}&key={TENOR_API_KEY}&client_key=zamboni_league&limit=20&media_filter=gif&contentfilter=medium"
            
            async with aiohttp.ClientSession() as session:
                async with session.get(url) as response:
                    if response.status == 200:
                        data = await response.json()
                        results = data.get('results', [])
                        if results:
                            # Pick a random GIF from results
                            gif = random.choice(results)
                            log.info(f'Found GIF for {team_code} using search: "{search_term}"')
                            return gif['media_formats']['gif']['url']
        
        return None
    except Exception as e:
        log.warning(f'Failed to fetch GIF for {team_code}: {e}')
        return None


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

        if event_type == 'draft_pick':
            return await self._handle_draft_pick(payload)
        if event_type == 'score_final':
            return await self._handle_score_event(payload)
        if event_type == 'trade_final':
            return await self._handle_trade_event(payload)
        if event_type == 'trade_proposed':
            return await self._handle_trade_proposed(payload)
        if event_type == 'trade_approved':
            return await self._handle_trade_approved(payload)
        if event_type == 'trade_rejected':
            return await self._handle_trade_rejected(payload)

        log.info('Unhandled bot event type: %s', event_type)
        return False

    async def _handle_draft_pick(self, payload: Dict[str, Any]) -> bool:
        ch_id = config.SCORES_CHANNEL  # Use scores channel for draft picks
        guild = self.bot.get_guild(config.GUILD_ID) if config.GUILD_ID else None
        channel = guild.get_channel(ch_id) if guild and ch_id else None

        log.info(f'Draft pick: guild={guild}, ch_id={ch_id}, channel={channel}')

        if not channel:
            log.warning('Draft pick event received but channel not configured')
            return False

        pick = payload.get('pick', {})
        player_name = pick.get('playerName', 'Unknown Player')
        position = pick.get('position', '')
        manager_name = pick.get('managerName', 'Unknown Manager')
        team_code = pick.get('teamCode', '')
        pick_num = pick.get('pick', 0)
        round_num = pick.get('round', 0)

        # Simple message for draft picks
        message = f"🎯 **Pick #{pick_num}** (Round {round_num}): **{manager_name}** ({team_code}) selects **{player_name}** ({position})"

        try:
            log.info(f'Sending draft pick message: {message[:50]}...')
            await channel.send(message)
            log.info('Draft pick posted successfully')
            return True
        except Exception as exc:
            log.warning('Failed to post draft pick: %s', exc, exc_info=True)
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

        # Determine winner and fetch GIF
        home_score = payload.get('homeScore', 0)
        away_score = payload.get('awayScore', 0)
        winner_team = payload.get('homeTeam') if home_score > away_score else payload.get('awayTeam')
        
        gif_url = await get_team_gif(winner_team) if winner_team else None
        if gif_url:
            embed.set_image(url=gif_url)
            log.info(f'Added GIF for winning team {winner_team}')

        view = discord.ui.View()
        view.add_item(discord.ui.Button(
            label='Open Player Portal',
            style=discord.ButtonStyle.link,
            url=config.APP_URL,
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

    async def _handle_trade_proposed(self, payload: Dict[str, Any]) -> bool:
        """Send DM to other GM when trade is proposed"""
        target_discord_id = payload.get('targetDiscordId')
        if not target_discord_id:
            log.warning('Trade proposed event missing targetDiscordId')
            return False
        
        try:
            user = await self.bot.fetch_user(int(target_discord_id))
            if not user:
                log.warning('Could not find Discord user: %s', target_discord_id)
                return False
            
            from_team = payload.get('fromTeam', '?')
            to_team = payload.get('toTeam', '?')
            proposed_by = payload.get('proposedBy', 'Someone')
            players_sent = payload.get('playersSent', [])
            players_received = payload.get('playersReceived', [])
            
            sent_str = ', '.join(players_sent) if players_sent else '—'
            recv_str = ', '.join(players_received) if players_received else '—'
            
            message = f"""🔄 **Trade Proposal**

{proposed_by} ({from_team}) wants to trade with you ({to_team})!

**{from_team} sends:** {sent_str}
**{to_team} sends:** {recv_str}

This trade is pending admin review. You'll be notified when it's approved or rejected."""
            
            await user.send(message)
            log.info('Trade proposal DM sent to user %s', target_discord_id)
            return True
            
        except Exception as exc:
            log.warning('Failed to send trade proposal DM: %s', exc)
            return False

    async def _handle_trade_approved(self, payload: Dict[str, Any]) -> bool:
        """Send DM when trade is approved"""
        target_discord_id = payload.get('targetDiscordId')
        if not target_discord_id:
            return False
        
        try:
            user = await self.bot.fetch_user(int(target_discord_id))
            if not user:
                return False
            
            from_team = payload.get('fromTeam', '?')
            to_team = payload.get('toTeam', '?')
            players_sent = payload.get('playersSent', [])
            players_received = payload.get('playersReceived', [])
            
            sent_str = ', '.join(players_sent) if players_sent else '—'
            recv_str = ', '.join(players_received) if players_received else '—'
            
            message = f"""✅ **Trade Approved!**

The trade between {from_team} and {to_team} has been approved!

**{from_team} sends:** {sent_str}
**{to_team} sends:** {recv_str}

Rosters have been updated. Check the trade hub for details!"""
            
            await user.send(message)
            log.info('Trade approved DM sent to user %s', target_discord_id)
            return True
            
        except Exception as exc:
            log.warning('Failed to send trade approved DM: %s', exc)
            return False

    async def _handle_trade_rejected(self, payload: Dict[str, Any]) -> bool:
        """Send DM when trade is rejected"""
        target_discord_id = payload.get('targetDiscordId')
        if not target_discord_id:
            return False
        
        try:
            user = await self.bot.fetch_user(int(target_discord_id))
            if not user:
                return False
            
            from_team = payload.get('fromTeam', '?')
            to_team = payload.get('toTeam', '?')
            
            message = f"""❌ **Trade Rejected**

The trade proposal between {from_team} and {to_team} was not approved by the admin.

You can propose a different trade anytime through the Player Portal."""
            
            await user.send(message)
            log.info('Trade rejected DM sent to user %s', target_discord_id)
            return True
            
        except Exception as exc:
            log.warning('Failed to send trade rejected DM: %s', exc)
            return False
