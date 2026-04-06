"""
embeds.py — Rich Discord embed builders styled to match the league site.

Colors mirror the site palette:
  SITE_RED  #CE1126  — game results, headers
  SITE_GOLD #D4AF37  — pending / approval requests
  SITE_GREEN #22c55e — approved trades
"""
import discord
from bot.config import APP_URL

# ── Palette ───────────────────────────────────────────────────────────────────
SITE_RED   = 0xCE1126
SITE_GOLD  = 0xD4AF37
SITE_GREEN = 0x22C55E
SITE_GREY  = 0x2B2D31   # Discord dark bg tone — used for neutral embeds

# ── Helpers ───────────────────────────────────────────────────────────────────

def _logo_url(code: str) -> str:
    """NHL team logo from the official CDN (SVG, light variant)."""
    return f'https://assets.nhle.com/logos/nhl/svg/{code}_light.svg'


def _manager_name(state: dict, team_code: str) -> str:
    """Return the manager name for a given team code, or empty string."""
    owners   = state.get('teamOwners', {})
    managers = {m['id']: m['name'] for m in state.get('managers', [])}
    return managers.get(owners.get(team_code, ''), '')


def _week_label(state: dict, week: int) -> str:
    """Return 'Week 2' or 'Week 2 · Mar 22 – Mar 28' if scheduleStartDate is set."""
    start_raw = state.get('scheduleStartDate')
    if not start_raw:
        return f'Week {week}'
    try:
        from datetime import date, timedelta
        start = date.fromisoformat(start_raw)
        w_start = start + timedelta(days=(week - 1) * 7)
        w_end   = w_start + timedelta(days=6)
        months  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        fmt = lambda d: f'{months[d.month-1]} {d.day}'
        return f'Week {week}  ·  {fmt(w_start)} – {fmt(w_end)}'
    except Exception:
        return f'Week {week}'


def _site_button() -> discord.ui.View:
    view = discord.ui.View()
    view.add_item(discord.ui.Button(
        label='📊 View Full Standings',
        style=discord.ButtonStyle.link,
        url=APP_URL,
    ))
    return view


# ── Score embeds ──────────────────────────────────────────────────────────────

def score_result_embed(payload: dict, state: dict, approved_by: str) -> discord.Embed:
    """
    Rich score-result card posted to the scores channel after approval.

    Layout:
        Author:  🏒 NHL LEGACY LEAGUE · GAME RESULT
        Title:   NYR  3 – 1  PIT  · OT          (no OT suffix if regulation)
        Fields:  [🏠 Home | 📊 Score | ✈️ Away]
                 [Manager | FINAL/OT | Manager  ]
        Thumbnail: winning team's logo
        Footer:  Week 2 · Mar 22 – Mar 28  ·  ✅ Approved by AdminName
    """
    ht  = payload['homeTeam']
    at  = payload['awayTeam']
    hs  = payload['homeScore']
    as_ = payload['awayScore']
    ot  = payload.get('ot', False)

    h_mgr = _manager_name(state, ht)
    a_mgr = _manager_name(state, at)
    winner = ht if hs > as_ else at
    period = '**OT**' if ot else 'FINAL'
    week   = _week_label(state, payload.get('week', 1))

    ot_suffix = '  · OT' if ot else ''
    embed = discord.Embed(
        title=f'{ht}  {hs} – {as_}  {at}{ot_suffix}',
        color=SITE_RED,
    )
    embed.set_author(name='🏒  GAME RESULT')

    embed.add_field(
        name='🏠  Home',
        value=f'**{ht}**\n{h_mgr}' if h_mgr else f'**{ht}**',
        inline=True,
    )
    embed.add_field(
        name='📊  Score',
        value=f'**{hs} – {as_}**\n{period}',
        inline=True,
    )
    embed.add_field(
        name='✈️  Away',
        value=f'**{at}**\n{a_mgr}' if a_mgr else f'**{at}**',
        inline=True,
    )

    embed.set_thumbnail(url=_logo_url(winner))
    embed.set_footer(text=f'{week}  ·  ✅ Approved by {approved_by}')
    return embed


def score_pending_embed(payload: dict, game: dict, submitter: str, state: dict) -> discord.Embed:
    """
    Pending-approval card sent to admin DMs / pending channel.
    Includes Zamboni box score stats when the submission came from the picker.
    """
    ht  = payload['homeTeam']
    at  = payload['awayTeam']
    hs  = payload['homeScore']
    as_ = payload['awayScore']
    ot  = payload.get('ot', False)

    h_mgr     = _manager_name(state, ht)
    a_mgr     = _manager_name(state, at)
    ot_suffix = '  · OT' if ot else ''
    week      = _week_label(state, game.get('week', 1))
    zb_id     = payload.get('zamboniGameId')

    embed = discord.Embed(
        title=f'📥  Score Submitted — {ht} {hs} – {as_} {at}{ot_suffix}',
        color=SITE_GOLD,
    )
    embed.add_field(
        name='🏠  Home',
        value=f'**{ht}**\n{h_mgr}' if h_mgr else f'**{ht}**',
        inline=True,
    )
    embed.add_field(name='📊  Score', value=f'**{hs} – {as_}**', inline=True)
    embed.add_field(
        name='✈️  Away',
        value=f'**{at}**\n{a_mgr}' if a_mgr else f'**{at}**',
        inline=True,
    )

    # Box score stats (only present when submitted via Zamboni picker)
    zs = payload.get('zamboniStats')
    if zs:
        h_st = zs.get('home', {})
        a_st = zs.get('away', {})
        fo_total = (h_st.get('fo', 0) + a_st.get('fo', 0)) or 1
        h_fo = round(h_st.get('fo', 0) / fo_total * 100)
        a_fo = 100 - h_fo

        def _toa(s):
            s = int(s or 0); return f"{s//60}:{s%60:02d}"

        embed.add_field(
            name=f'📊  {ht}',
            value=(
                f"Shots **{h_st.get('shots','?')}**\n"
                f"Hits **{h_st.get('hits','?')}**\n"
                f"PP **{h_st.get('ppg',0)}/{h_st.get('ppo',0)}**\n"
                f"FO% **{h_fo}%**\n"
                f"TOA **{_toa(h_st.get('toa',0))}**"
            ),
            inline=True,
        )
        embed.add_field(
            name=f'📊  {at}',
            value=(
                f"Shots **{a_st.get('shots','?')}**\n"
                f"Hits **{a_st.get('hits','?')}**\n"
                f"PP **{a_st.get('ppg',0)}/{a_st.get('ppo',0)}**\n"
                f"FO% **{a_fo}%**\n"
                f"TOA **{_toa(a_st.get('toa',0))}**"
            ),
            inline=True,
        )

    embed.set_thumbnail(url=_logo_url(ht))
    footer = f'{week}  ·  Submitted by {submitter}'
    if zb_id:
        footer += f'  ·  Zamboni #{zb_id}'
    embed.set_footer(text=footer)
    return embed


# ── Trade embeds ──────────────────────────────────────────────────────────────

def _team_label(code: str, mgr: str) -> str:
    return f'**{code}**\n{mgr}' if mgr else f'**{code}**'


def _player_list(players: list[str], state: dict, team_code: str) -> str:
    """Format player list with OVR/PLT if available in state."""
    player_map = {p['name']: p for p in state.get('players', [])}
    lines = []
    for name in players:
        p = player_map.get(name)
        if p and p.get('ovr') and p.get('plt'):
            lines.append(f'• **{name}**  *{p["ovr"]} {p["plt"]}*')
        else:
            lines.append(f'• **{name}**')
    return '\n'.join(lines) or '—'


def trade_result_embed(payload: dict, teams: list[dict], state: dict, approved_by: str) -> discord.Embed:
    """
    Rich trade card posted to the trades channel after approval.

    Layout:
        Author:  🔄 TRADE WIRE
        Title:   BOS ↔ TOR
        Fields:  [BOS sends → | ← TOR sends]
                 [player list | player list  ]
        Notes field if present
        Footer:  ✅ Approved by AdminName  ·  View full trade wire at site
    """
    from_code = payload['fromTeam']
    to_code   = payload['toTeam']
    sent      = payload.get('playersSent', [])
    received  = payload.get('playersReceived', [])
    notes     = payload.get('notes', '').strip()

    def _team_name(code):
        t = next((x for x in teams if x.get('code', '').upper() == code.upper()), None)
        return t['name'] if t else code

    from_name = _team_name(from_code)
    to_name   = _team_name(to_code)
    from_mgr  = _manager_name(state, from_code)
    to_mgr    = _manager_name(state, to_code)

    embed = discord.Embed(
        title=f'{from_code}  ↔  {to_code}',
        color=SITE_GREEN,
    )
    embed.set_author(name='🔄  TRADE WIRE')

    embed.add_field(
        name=f'{from_name} sends  →',
        value=_player_list(sent, state, from_code),
        inline=True,
    )
    embed.add_field(
        name=f'←  {to_name} sends',
        value=_player_list(received, state, to_code),
        inline=True,
    )

    if notes:
        embed.add_field(name='📝 Notes', value=notes, inline=False)

    embed.add_field(
        name='\u200b',
        value=f'[📊 Full Trade Wire & Standings]({APP_URL})',
        inline=False,
    )
    embed.set_footer(text=f'✅ Approved by {approved_by}')

    # Thumbnail — logo of the team sending the star player (highest OVR)
    all_players = state.get('players', [])
    best_sent = max(
        (p for p in all_players if p['name'] in sent),
        key=lambda p: p.get('ovr', 0), default=None
    )
    if best_sent:
        embed.set_thumbnail(url=_logo_url(from_code))

    return embed


def trade_pending_embed(payload: dict, teams: list[dict], state: dict, submitter: str, req_id: str) -> discord.Embed:
    """
    Pending-approval trade card sent to admin DMs / pending channel.
    """
    from_code = payload['fromTeam']
    to_code   = payload['toTeam']
    sent      = payload.get('playersSent', [])
    received  = payload.get('playersReceived', [])
    notes     = payload.get('notes', '').strip()

    def _team_name(code):
        t = next((x for x in teams if x.get('code', '').upper() == code.upper()), None)
        return t['name'] if t else code

    from_name = _team_name(from_code)
    to_name   = _team_name(to_code)

    embed = discord.Embed(
        title=f'📥  Trade Submitted — {from_code} ↔ {to_code}',
        color=SITE_GOLD,
    )
    embed.add_field(
        name=f'{from_name} sends  →',
        value=_player_list(sent, state, from_code),
        inline=True,
    )
    embed.add_field(
        name=f'←  {to_name} sends',
        value=_player_list(received, state, to_code),
        inline=True,
    )
    if notes:
        embed.add_field(name='📝 Notes', value=notes, inline=False)
    embed.set_footer(text=f'ID: {req_id[:8]}…  ·  Submitted by {submitter}')
    return embed
