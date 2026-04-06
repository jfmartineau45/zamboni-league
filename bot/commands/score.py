"""
commands/score.py  —  /score command

Two-step Zamboni game picker (when the submitter has a discordId + zamboniTag set):
  Step 1  Pick the league schedule game  (all unplayed games for your team, any week)
  Step 2  Pick the Zamboni game result   (recent completed games between both managers)
  Step 3  Confirm + submit for admin approval

Falls back to a manual modal (pick game → type scores) when the user isn't linked.
"""
import discord
from discord import app_commands
from discord.ext import commands
from datetime import datetime

from bot.api import (
    api_post, api_patch, get_state,
    get_zamboni_player, get_zamboni_game_report,
)
from bot import config
from bot.embeds import score_result_embed, score_pending_embed, _site_button


# ── Pure helpers ──────────────────────────────────────────────────────────────

_PO_ROUND_LABELS = {
    100: 'First Round',
    101: 'Second Round',
    102: 'Conference Finals',
    103: 'Championship',
}

def _game_label(g: dict) -> str:
    """Human-readable game label for Discord select menus."""
    week = g.get('week', '?')
    ht   = g.get('homeTeam', '?')
    at   = g.get('awayTeam', '?')
    if isinstance(week, int) and week >= 100:
        round_name = _PO_ROUND_LABELS.get(week, f'Playoffs Rd {week - 99}')
        notes      = g.get('notes', '')
        game_num   = ''
        if '– Game' in notes:
            game_num = '  ' + notes.split('– Game')[-1].strip().replace('Game ', 'G')
        return f'🏒 {round_name}{game_num}  ·  {ht} vs {at}'
    return f'Wk {week}  ·  {ht} vs {at}'


def _find_manager_by_discord(state: dict, discord_id: str) -> dict | None:
    """Return manager dict whose discordId matches, or None."""
    return next(
        (m for m in state.get('managers', [])
         if str(m.get('discordId', '')) == discord_id),
        None,
    )


def _get_team_for_manager(state: dict, mgr_id: str) -> str | None:
    """Return the team code owned by this manager, or None."""
    return next(
        (code for code, mid in state.get('teamOwners', {}).items() if mid == mgr_id),
        None,
    )


def _fmt_date(created_at: str) -> str:
    """'2026-04-03T20:07:12Z' → 'Apr 3  8:07pm'"""
    if not created_at:
        return ''
    try:
        dt = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
        months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec']
        hr   = dt.hour % 12 or 12
        ampm = 'am' if dt.hour < 12 else 'pm'
        return f"{months[dt.month-1]} {dt.day}  {hr}:{dt.minute:02d}{ampm}"
    except Exception:
        return created_at[:10]


def _build_zamboni_options(
    h_tag: str, a_tag: str,
    h_history: list, a_history: list,
) -> list[dict]:
    """
    Find games where h_tag played a_tag (intersection of both players' histories).
    Returns list of dicts sorted by most recent first, capped at 20.
    """
    h_by_id = {
        h['game_id']: h for h in h_history
        if h.get('opponent', '').lower() == a_tag
    }
    a_by_id = {
        h['game_id']: h for h in a_history
        if h.get('opponent', '').lower() == h_tag
    }

    results = []
    for gid in set(h_by_id) & set(a_by_id):
        hs = h_by_id[gid]
        as_ = a_by_id[gid]
        h_score = hs.get('scor', '?')
        a_score = as_.get('scor', '?')
        is_ot   = bool((hs.get('otg') or 0) > 0 or (as_.get('otg') or 0) > 0)
        ot_tag  = ' OT' if is_ot else ''
        date_str = _fmt_date(hs.get('created_at', ''))
        label = f"{h_tag}  {h_score} – {a_score}  {a_tag}{ot_tag}"
        if date_str:
            label += f"  ·  {date_str}"
        results.append({
            'game_id':    gid,
            'h_side':     hs,
            'a_side':     as_,
            'created_at': hs.get('created_at', ''),
            'label':      label[:100],
            'is_ot':      is_ot,
        })

    results.sort(key=lambda x: x['created_at'], reverse=True)
    return results[:20]


def _side_stats(hist: dict) -> dict:
    """Extract the stats we store from a Zamboni history entry."""
    return {
        'shots': hist.get('shts', 0),
        'hits':  hist.get('hits',  0),
        'ppg':   hist.get('ppg',   0),
        'ppo':   hist.get('ppo',   0),
        'shg':   hist.get('shg',   0),
        'fo':    hist.get('fo',    0),
        'fol':   hist.get('fol',   0),
        'toa':   hist.get('toa',   0),
        'pims':  hist.get('pims',  0),
    }


# ── Admin notification helper ─────────────────────────────────────────────────

async def _notify_admins(
    bot_ref: commands.Bot,
    interaction: discord.Interaction,
    req_id: str,
    payload: dict,
    game: dict,
    submitter_name: str,
    state: dict,
):
    from bot.api import get_discord_config
    dc = await get_discord_config()

    raw_pc_id = dc.get('pendingChannel') or ''
    try:
        pending_ch_id = int(raw_pc_id) if str(raw_pc_id).strip() else config.PENDING_CHANNEL
    except (ValueError, AttributeError):
        pending_ch_id = config.PENDING_CHANNEL

    pend_embed = score_pending_embed(payload, game, submitter_name, state)
    view = ScoreApprovalView(req_id, payload, submitter_name, bot_ref)

    # DM every admin-role member (only if adminDm is enabled)
    admin_dm_enabled = dc.get('adminDm', True)  # Default to True if not set
    if admin_dm_enabled and config.ADMIN_ROLE_ID and interaction.guild:
        role = interaction.guild.get_role(config.ADMIN_ROLE_ID)
        if role:
            for member in role.members:
                try:
                    await member.send(embed=pend_embed, view=view)
                except discord.Forbidden:
                    pass

    # Post to pending channel
    if pending_ch_id and interaction.guild:
        ch = interaction.guild.get_channel(pending_ch_id)
        if ch:
            try:
                await ch.send(embed=pend_embed, view=view)
            except Exception:
                pass


# ── Admin approval buttons ────────────────────────────────────────────────────

class ScoreApprovalView(discord.ui.View):
    def __init__(self, req_id: str, payload: dict, submitter: str, bot_ref: commands.Bot):
        super().__init__(timeout=None)
        self.req_id    = req_id
        self.payload   = payload
        self.submitter = submitter
        self.bot_ref   = bot_ref

    @discord.ui.button(label='✅ Approve', style=discord.ButtonStyle.success)
    async def approve(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        from bot.auth import get_token
        status, body = await api_patch(
            f'/api/pending/{self.req_id}',
            {'action': 'approve'},
            token=get_token(),
        )
        if status != 200 or not body.get('ok'):
            await interaction.followup.send(f"Error: {body.get('error', '?')}", ephemeral=True)
            return

        await interaction.edit_original_response(
            content=f'✅ **Approved** by {interaction.user.mention}',
            view=None,
        )

        # Post result to scores channel
        from bot.api import get_discord_config
        dc = await get_discord_config()
        raw_ch_id = dc.get('scoresChannel') or ''
        try:
            ch_id = int(raw_ch_id) if str(raw_ch_id).strip() else config.SCORES_CHANNEL
        except (ValueError, AttributeError):
            ch_id = config.SCORES_CHANNEL

        scores_ch = None
        if ch_id:
            guild = interaction.guild or (
                self.bot_ref.get_guild(config.GUILD_ID) if config.GUILD_ID else None
            )
            scores_ch = guild.get_channel(ch_id) if guild else None

        state    = await get_state()
        game_rec = next(
            (g for g in state.get('games', []) if g['id'] == str(self.payload.get('gameId', ''))),
            {},
        )
        enriched     = {**self.payload, 'week': game_rec.get('week', 1)}
        result_embed = score_result_embed(enriched, state, interaction.user.display_name)

        if scores_ch:
            await scores_ch.send(embed=result_embed, view=_site_button())
        else:
            import logging
            logging.getLogger('nhl-bot').warning(
                'Score approved but no scores channel configured'
            )

    @discord.ui.button(label='❌ Reject', style=discord.ButtonStyle.danger)
    async def reject(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        from bot.auth import get_token
        status, body = await api_patch(
            f'/api/pending/{self.req_id}',
            {'action': 'reject'},
            token=get_token(),
        )
        if status == 200 and body.get('ok'):
            await interaction.edit_original_response(
                content=f'❌ **Rejected** by {interaction.user.mention}',
                view=None,
            )
        else:
            await interaction.followup.send(f"Error: {body.get('error', '?')}", ephemeral=True)


# ── Step 3 — Confirm / Cancel ─────────────────────────────────────────────────

class ScoreConfirmView(discord.ui.View):
    def __init__(self, payload: dict, game: dict, bot_ref: commands.Bot):
        super().__init__(timeout=300)
        self.payload  = payload
        self.game     = game
        self.bot_ref  = bot_ref

    @discord.ui.button(label='✅ Submit', style=discord.ButtonStyle.success)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()

        status, body = await api_post('/api/pending', {
            'type':          'score',
            'payload':       self.payload,
            'submittedBy':   str(interaction.user.id),
            'submittedName': interaction.user.display_name,
        })
        if status != 200:
            await interaction.edit_original_response(
                content=f"❌ Submit failed: {body.get('error', '?')}",
                embed=None, view=None,
            )
            return

        req_id = body['id']
        p      = self.payload
        ot_tag = ' (OT)' if p.get('ot') else ''
        await interaction.edit_original_response(
            content=(
                f"✅ **{p['homeTeam']} {p['homeScore']} – {p['awayScore']} {p['awayTeam']}**{ot_tag}\n"
                f"Submitted! Waiting for admin approval."
            ),
            embed=None, view=None,
        )

        state = await get_state()
        await _notify_admins(
            self.bot_ref, interaction, req_id,
            self.payload, self.game,
            interaction.user.display_name, state,
        )

    @discord.ui.button(label='✗ Cancel', style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(
            content='Score submission cancelled.', embed=None, view=None,
        )


# ── Step 2 — Zamboni game picker ──────────────────────────────────────────────

class ZamboniGameSelect(discord.ui.Select):
    def __init__(
        self,
        zb_opts: list[dict],
        league_game: dict,
        home_mgr: dict,
        away_mgr: dict,
        bot_ref: commands.Bot,
    ):
        self.zb_opts    = zb_opts
        self.league_game = league_game
        self.home_mgr   = home_mgr
        self.away_mgr   = away_mgr
        self.bot_ref    = bot_ref

        options = [
            discord.SelectOption(label=opt['label'], value=str(opt['game_id']))
            for opt in zb_opts
        ]
        super().__init__(
            placeholder='Pick the Zamboni game that counts…',
            options=options,
            min_values=1, max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer()

        gid = int(self.values[0])
        opt = next(o for o in self.zb_opts if o['game_id'] == gid)
        g   = self.league_game

        h_side = opt['h_side']
        a_side = opt['a_side']
        h_score = int(h_side.get('scor', 0))
        a_score = int(a_side.get('scor', 0))
        is_ot   = opt['is_ot']

        payload = {
            'gameId':       g['id'],
            'homeTeam':     g['homeTeam'],
            'awayTeam':     g['awayTeam'],
            'homeScore':    h_score,
            'awayScore':    a_score,
            'ot':           is_ot,
            'zamboniGameId': gid,
            'zamboniStats': {
                'home': _side_stats(h_side),
                'away': _side_stats(a_side),
            },
        }

        # ── Build confirmation embed ──────────────────────────────────────────
        ot_tag  = ' · OT' if is_ot else ''
        zs      = payload['zamboniStats']
        h_st    = zs['home']
        a_st    = zs['away']
        ht      = g['homeTeam']
        at      = g['awayTeam']

        fo_total  = (h_st['fo'] + a_st['fo']) or 1
        h_fo_pct  = round(h_st['fo'] / fo_total * 100)
        a_fo_pct  = 100 - h_fo_pct

        def toa_fmt(s: int) -> str:
            s = int(s or 0)
            return f"{s//60}:{s%60:02d}"

        embed = discord.Embed(
            title=f'{ht}  {h_score} – {a_score}  {at}{ot_tag}',
            description=f"{_game_label(g)}  ·  Zamboni game #{gid}",
            color=0xD4AF37,
        )
        embed.add_field(
            name=f'📊  {ht}',
            value=(
                f"Shots **{h_st['shots']}**\n"
                f"Hits **{h_st['hits']}**\n"
                f"PP **{h_st['ppg']}/{h_st['ppo']}**\n"
                f"FO% **{h_fo_pct}%**\n"
                f"TOA **{toa_fmt(h_st['toa'])}**"
            ),
            inline=True,
        )
        embed.add_field(
            name=f'📊  {at}',
            value=(
                f"Shots **{a_st['shots']}**\n"
                f"Hits **{a_st['hits']}**\n"
                f"PP **{a_st['ppg']}/{a_st['ppo']}**\n"
                f"FO% **{a_fo_pct}%**\n"
                f"TOA **{toa_fmt(a_st['toa'])}**"
            ),
            inline=True,
        )
        embed.set_footer(text='Looks right? Hit Submit to send for admin approval.')

        view = ScoreConfirmView(payload, g, self.bot_ref)
        await interaction.edit_original_response(content=None, embed=embed, view=view)


class ZamboniGameView(discord.ui.View):
    def __init__(self, zb_opts, league_game, home_mgr, away_mgr, bot_ref):
        super().__init__(timeout=300)
        self.add_item(ZamboniGameSelect(zb_opts, league_game, home_mgr, away_mgr, bot_ref))


# ── Step 1 — League game picker ───────────────────────────────────────────────

class LeagueGameSelect(discord.ui.Select):
    def __init__(self, my_games: list, state: dict, bot_ref: commands.Bot):
        self.my_games = my_games
        self.state    = state
        self.bot_ref  = bot_ref

        options = [
            discord.SelectOption(
                label=_game_label(g),
                value=g['id'],
            )
            for g in my_games[:25]
        ]
        super().__init__(
            placeholder='Pick the league game you played…',
            options=options,
            min_values=1, max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer()

        g = next((x for x in self.my_games if x['id'] == self.values[0]), None)
        if not g:
            await interaction.edit_original_response(content='Game not found. Try again.', view=None)
            return

        owners   = self.state.get('teamOwners', {})
        mgr_map  = {m['id']: m for m in self.state.get('managers', [])}
        home_mgr = mgr_map.get(owners.get(g['homeTeam'], ''))
        away_mgr = mgr_map.get(owners.get(g['awayTeam'], ''))

        if not home_mgr or not away_mgr:
            await interaction.edit_original_response(
                content=f"Can't find manager for {g['homeTeam']} or {g['awayTeam']}. Contact admin.",
                view=None,
            )
            return

        h_tag = (home_mgr.get('zamboniTag') or '').lower()
        a_tag = (away_mgr.get('zamboniTag') or '').lower()

        if not h_tag or not a_tag:
            missing = ', '.join(
                t for t, tag in [(g['homeTeam'], h_tag), (g['awayTeam'], a_tag)] if not tag
            )
            await interaction.edit_original_response(
                content=f"⚠️ Zamboni tag not set for **{missing}**. Ask admin to link their account in Settings.",
                view=None,
            )
            return

        await interaction.edit_original_response(
            content=f"Fetching Zamboni games between **{h_tag}** and **{a_tag}**…",
            view=None,
        )

        h_data, a_data = await asyncio.gather(
            get_zamboni_player(h_tag),
            get_zamboni_player(a_tag),
        )

        if not h_data.get('history') or not a_data.get('history'):
            await interaction.edit_original_response(
                content=(
                    f"⚠️ Zamboni API unavailable — enter the score manually for "
                    f"**Wk {g.get('week','?')} · {g['homeTeam']} vs {g['awayTeam']}**:"
                ),
                view=ManualGameView([g], self.bot_ref),
            )
            return

        h_hist = [*h_data['history'].get('vs', []), *h_data['history'].get('so', [])]
        a_hist = [*a_data['history'].get('vs', []), *a_data['history'].get('so', [])]
        zb_opts = _build_zamboni_options(h_tag, a_tag, h_hist, a_hist)

        if not zb_opts:
            await interaction.edit_original_response(
                content=(
                    f"⚠️ No Zamboni games found between **{h_tag}** and **{a_tag}** — "
                    f"enter the score manually for **Wk {g.get('week','?')} · {g['homeTeam']} vs {g['awayTeam']}**:"
                ),
                view=ManualGameView([g], self.bot_ref),
            )
            return

        wk_label = f"Wk {g.get('week','?')}  ·  {g['homeTeam']} vs {g['awayTeam']}"
        view = ZamboniGameView(zb_opts, g, home_mgr, away_mgr, self.bot_ref)
        await interaction.edit_original_response(
            content=f"**Step 2/2** — Pick the Zamboni game for **{wk_label}** ({len(zb_opts)} found):",
            view=view,
        )


class LeagueGameView(discord.ui.View):
    def __init__(self, my_games, state, bot_ref):
        super().__init__(timeout=300)
        self.add_item(LeagueGameSelect(my_games, state, bot_ref))


# ── Manual fallback (no discordId / zamboniTag) ───────────────────────────────

class ManualConfirmView(discord.ui.View):
    """Shown after the user types scores — lets them confirm or re-enter."""
    def __init__(self, payload: dict, game: dict, bot_ref: commands.Bot):
        super().__init__(timeout=300)
        self.payload  = payload
        self.game     = game
        self.bot_ref  = bot_ref

    @discord.ui.button(label='✅ Submit', style=discord.ButtonStyle.success)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        p = self.payload
        g = self.game
        status, body = await api_post('/api/pending', {
            'type':          'score',
            'payload':       p,
            'submittedBy':   str(interaction.user.id),
            'submittedName': interaction.user.display_name,
        })
        if status != 200:
            await interaction.edit_original_response(
                content=f"❌ Submit failed: {body.get('error', '?')}",
                view=None,
            )
            return

        req_id = body['id']
        ot_tag = ' (OT)' if p.get('ot') else ''
        await interaction.edit_original_response(
            content=(
                f"✅ **{p['homeTeam']} {p['homeScore']} – {p['awayScore']} {p['awayTeam']}**{ot_tag}\n"
                f"Submitted! Waiting for admin approval."
            ),
            view=None,
        )
        state = await get_state()
        await _notify_admins(
            self.bot_ref, interaction, req_id,
            p, g, interaction.user.display_name, state,
        )

    @discord.ui.button(label='✗ Wrong — re-enter', style=discord.ButtonStyle.secondary)
    async def wrong(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Re-open the score modal so they can correct the numbers."""
        await interaction.response.send_modal(ManualScoreModal(self.game, self.bot_ref))


class ManualScoreModal(discord.ui.Modal):
    """Score entry modal with team-specific labels to prevent home/away mix-ups."""

    def __init__(self, game: dict, bot_ref: commands.Bot):
        ht = game.get('homeTeam', 'Home')
        at = game.get('awayTeam', 'Away')
        super().__init__(title=f'{ht} vs {at} — Enter scores')
        self.game    = game
        self.bot_ref = bot_ref

        # Dynamic labels so it's impossible to mix up home vs away
        self.home_score = discord.ui.TextInput(
            label=f'{ht} score  (home 🏠)',
            placeholder='3',
            max_length=2,
        )
        self.away_score = discord.ui.TextInput(
            label=f'{at} score  (away ✈️)',
            placeholder='1',
            max_length=2,
        )
        self.overtime = discord.ui.TextInput(
            label='Overtime? (y/n)',
            placeholder='n',
            max_length=1,
            required=False,
        )
        self.add_item(self.home_score)
        self.add_item(self.away_score)
        self.add_item(self.overtime)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            hs  = int(self.home_score.value.strip())
            as_ = int(self.away_score.value.strip())
        except ValueError:
            await interaction.followup.send('Invalid scores — enter numbers only.', ephemeral=True)
            return

        if hs == as_:
            await interaction.followup.send(
                'Scores cannot be tied — every NHL game has a winner.', ephemeral=True,
            )
            return

        ot  = self.overtime.value.strip().lower() in ('y', 'yes', '1')
        g   = self.game
        ht  = g['homeTeam']
        at  = g['awayTeam']
        ot_label = ' · OT' if ot else ' · REG'

        payload = {
            'gameId':    g['id'],
            'homeTeam':  ht,
            'awayTeam':  at,
            'homeScore': hs,
            'awayScore': as_,
            'ot':        ot,
        }

        # Show confirmation before submitting — one last chance to catch a mistake
        view = ManualConfirmView(payload, g, self.bot_ref)
        await interaction.followup.send(
            f"**Confirm score:**\n"
            f"🏠 **{ht}** {hs}  –  {as_} **{at}** ✈️{ot_label}\n"
            f"Week {g.get('week', '?')} — is this correct?",
            view=view,
            ephemeral=True,
        )


class ManualGameSelect(discord.ui.Select):
    def __init__(self, week_games: list, bot_ref: commands.Bot):
        self.all_games = week_games
        self.bot_ref   = bot_ref
        options = [
            discord.SelectOption(
                label=_game_label(g),
                value=g['id'],
            )
            for g in week_games[:25]
        ]
        super().__init__(placeholder='Pick your game…', options=options, min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        g = next((x for x in self.all_games if x['id'] == self.values[0]), None)
        if not g:
            await interaction.response.send_message('Game not found.', ephemeral=True)
            return
        await interaction.response.send_modal(ManualScoreModal(g, self.bot_ref))


class ManualGameView(discord.ui.View):
    def __init__(self, week_games, bot_ref):
        super().__init__(timeout=300)
        self.add_item(ManualGameSelect(week_games, bot_ref))


# ── Cog ───────────────────────────────────────────────────────────────────────

import asyncio  # noqa: E402 — imported here to avoid circular issues at module top

class ScoreCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name='score', description='Submit a game result for approval')
    async def score(self, interaction: discord.Interaction):
        await interaction.response.defer(thinking=True, ephemeral=True)

        state      = await get_state()
        discord_id = str(interaction.user.id)
        mgr        = _find_manager_by_discord(state, discord_id)

        # ── Zamboni flow ──────────────────────────────────────────────────────
        if mgr and mgr.get('zamboniTag'):
            team_code = _get_team_for_manager(state, mgr['id'])
            if not team_code:
                await interaction.followup.send(
                    '⚠️ Your account has no team assigned. Contact the admin.',
                    ephemeral=True,
                )
                return

            my_games = sorted(
                [
                    g for g in state.get('games', [])
                    if not g.get('played')
                    and (g.get('homeTeam') == team_code or g.get('awayTeam') == team_code)
                ],
                key=lambda g: (g.get('week', 999), g.get('id', '')),
            )

            if not my_games:
                await interaction.followup.send(
                    f'No unplayed games found for **{team_code}**.',
                    ephemeral=True,
                )
                return

            view = LeagueGameView(my_games, state, self.bot)
            po_count = sum(1 for g in my_games if g.get('playoff'))
            extra = f'  ·  {po_count} playoff' if po_count else ''
            await interaction.followup.send(
                f'**Step 1/2** — Pick the league game you played ({len(my_games)} unplayed{extra} for **{team_code}**):',
                view=view,
                ephemeral=True,
            )
            return

        # ── Manual fallback ───────────────────────────────────────────────────
        games        = state.get('games', [])
        unplayed     = [g for g in games if not g.get('played')]
        reg_weeks    = [g['week'] for g in unplayed if (g.get('week') or 0) < 100]
        po_weeks     = [g['week'] for g in unplayed if (g.get('week') or 0) >= 100]
        cur_week     = min(reg_weeks) if reg_weeks else (min(po_weeks) if po_weeks else 1)
        week_games   = [g for g in unplayed if g.get('week') == cur_week]

        if not week_games:
            await interaction.followup.send('No unplayed games this week.', ephemeral=True)
            return

        hint = ''
        if not mgr:
            hint = '\n*Link your Discord account in Settings to use the Zamboni picker.*'

        week_label = _PO_ROUND_LABELS.get(cur_week, f'Week {cur_week}') if cur_week >= 100 else f'Week {cur_week}'
        view = ManualGameView(week_games, self.bot)
        await interaction.followup.send(
            f'**Manual score entry** ({week_label}) — pick your game:{hint}',
            view=view,
            ephemeral=True,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(ScoreCog(bot))
