/* ============================================================
   NHL Legacy League Manager — app.js
   
   Main application logic for admin panel, public dashboard,
   settings, trades, games, schedules, and draft management.
   
   Modular structure (load order):
   1. draft.js          — draft logic
   2. portal-shared.js  — portal session/cache/fetch helpers
   3. portal-ui.js      — portal UI actions (login/trades)
   4. admin-pending.js  — admin pending trade review
   5. app.js            — this file (core app logic)
   
   Pure HTML/CSS/JS, no dependencies, no build step.
   Data persisted in localStorage + backend API.
   ============================================================ */

'use strict';

// ================================================================
// FEATURE FLAGS
// ================================================================
const FEATURE_FLAGS = {
  ENABLE_PLAYER_STATS: false,  // Set to true when you have automated stats API
  ENABLE_MANUAL_STATS: false   // Manual stat entry (too much work without API)
};

// ================================================================
// 1. AUTO-UPDATE DETECTION
// ================================================================
let _currentVersion = null;

async function checkForUpdates() {
  try {
    const response = await fetch('/version.json?t=' + Date.now(), {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    
    if (!response.ok) {
      console.warn('[Update] Failed to fetch version.json:', response.status);
      return;
    }
    
    const data = await response.json();
    console.log('[Update] Current:', _currentVersion, 'Remote:', data.timestamp);
    
    if (!_currentVersion) {
      _currentVersion = data.timestamp;
      return;
    }
    
    if (data.timestamp !== _currentVersion) {
      console.log('[Update] New version detected! Auto-reloading in 2 seconds...');
      
      // Show brief notification before reload
      const updateToast = document.createElement('div');
      updateToast.id = 'update-toast';
      updateToast.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px">
          <span>🔄 Updating...</span>
        </div>
      `;
      updateToast.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10000;padding:12px 20px;background:#1a3a5a;border:1px solid #4a8cc8;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-size:0.9rem;color:#fff';
      document.body.appendChild(updateToast);
      
      // Auto-reload after 2 seconds
      setTimeout(() => {
        location.reload();
      }, 2000);
    }
  } catch (err) {
    console.warn('[Update] Error checking for updates:', err);
  }
}

// Check for updates every 30 seconds
setInterval(checkForUpdates, 30000);
checkForUpdates();

// ================================================================
// 1b. LIVE DATA UPDATES via Server-Sent Events
// ================================================================
let _sseSource = null;
let _sseReconnectDelay = 1000;
let _lastSelfSaveAt = 0; // set by saveState so we can suppress echo updates

function _isModalOpen() {
  const m = document.getElementById('modal-overlay');
  return m && !m.classList.contains('hidden');
}

let _pendingLiveReload = false;

async function _liveReloadState() {
  // Don't yank state while a modal is open — its Save handler holds refs
  // into the current state. Queue it to run right after hideModal.
  if (_isModalOpen()) {
    _pendingLiveReload = true;
    console.log('[Live] Reload deferred - modal is open');
    return;
  }
  try {
    console.log('[Live] Reloading state and re-rendering:', currentSection);
    const playedBefore = state.games.filter(g => g.played).length;
    const fresh = await loadState();
    if (!fresh) {
      console.warn('[Live] loadState returned nothing');
      return;
    }
    // Preserve local-only fields the server doesn't own
    const preserved = {
      sysDataFile: state.sysDataFile,
    };
    Object.assign(state, fresh, preserved);
    const playedAfter = state.games.filter(g => g.played).length;
    console.log(`[Live] Games played: ${playedBefore} → ${playedAfter} (fresh had ${fresh.games.filter(g => g.played).length})`);
    
    // Re-render the current section
    if (typeof renderSection === 'function' && currentSection) {
      console.log('[Live] Re-rendering current section:', currentSection);
      
      // Update page title to show refresh happened (debug)
      const now = new Date();
      const timeStr = now.toLocaleTimeString();
      document.title = `NHL Legacy (updated ${timeStr})`;
      
      renderSection(currentSection);
      console.log('[Live] Re-rendered:', currentSection);
      
      // Visual feedback: flash the section to show it updated
      const sectionEl = document.getElementById(`section-${currentSection}`);
      if (sectionEl) {
        sectionEl.style.transition = 'opacity 0.2s';
        sectionEl.style.opacity = '0.5';
        setTimeout(() => {
          sectionEl.style.opacity = '1';
        }, 100);
      }
      
      // FORCE a full DOM update by triggering a reflow
      const mainContent = document.getElementById('main-content');
      if (mainContent) {
        void mainContent.offsetHeight; // Force reflow
      }
    } else {
      console.warn('[Live] renderSection not available or no currentSection');
    }
  } catch (err) {
    console.warn('[Live] reload failed:', err);
  }
}

function _handleDraftPickMade(data) {
  // Optimized handler for draft_pick_made event
  // Updates only the necessary parts without full reload
  
  const pick = data?.pick;
  const nextOnClock = data?.nextOnClock;
  const draftComplete = data?.draftComplete;
  
  if (!pick) return;
  
  // Show toast notification
  toast(`${pick.playerName} (${pick.position}) → ${pick.managerName}`, 'info');
  
  // Update admin draft module if loaded
  if (window.DraftModule && typeof window.DraftModule.handleLivePick === 'function') {
    window.DraftModule.handleLivePick(pick, nextOnClock, draftComplete);
  }
  
  // Update portal draft if loaded
  if (typeof renderPortalDraft === 'function' && currentSection === 'draft') {
    // Reload state first to get updated picks, then re-render
    loadState().then(() => {
      renderPortalDraft();
    });
  }
  
  // If on teams page, update the roster count
  if (currentSection === 'teams') {
    // Just reload state and re-render teams for now
    // TODO: Make this more targeted later
    _liveReloadState();
  }
  
  // If draft is complete, show celebration
  if (draftComplete) {
    setTimeout(() => {
      toast('🎉 Draft Complete!', 'success');
    }, 500);
  }
}

function _handleScoreUpdated(data) {
  // Optimized handler for score_updated event
  // Updates only the affected game without full reload
  
  if (!data || !data.gameId) return;
  
  // Show toast notification
  const scoreText = `${data.homeTeam} ${data.homeScore} - ${data.awayScore} ${data.awayTeam}${data.ot ? ' (OT)' : ''}`;
  toast(scoreText, 'info');
  
  // If on scores or schedule page, reload state and re-render
  // TODO: Make this more targeted (just update the game card)
  if (currentSection === 'scores' || currentSection === 'schedule') {
    loadState().then(() => {
      renderSection(currentSection);
    });
  }
  
  // If on standings page, reload (score affects standings)
  if (currentSection === 'standings') {
    loadState().then(() => {
      renderStandings();
    });
  }
}

function _handleScoreApproved(data) {
  // Handler for score_approved event
  // Notifies submitter that their score was approved
  
  if (!data || !data.gameId) return;
  
  // Show toast notification
  const scoreText = `${data.homeTeam} ${data.homeScore} - ${data.awayScore} ${data.awayTeam}`;
  toast(`Score approved: ${scoreText}`, 'success');
  
  // If on scores page, reload and re-render
  if (currentSection === 'scores' || currentSection === 'schedule') {
    loadState().then(() => {
      renderSection(currentSection);
    });
  }
  
  // Update standings if visible
  if (currentSection === 'standings') {
    loadState().then(() => {
      renderStandings();
    });
  }
}

function _handleTradeProposed(data) {
  // Handler for trade_proposed event
  // Notifies target manager of trade offer
  
  if (!data || !data.tradeId) return;
  
  // Show toast notification
  const offeredPlayers = data.playersOffered?.map(p => p.name).join(', ') || 'players';
  const requestedPlayers = data.playersRequested?.map(p => p.name).join(', ') || 'players';
  toast(`Trade offer from ${data.fromManager?.name}: ${requestedPlayers} for ${offeredPlayers}`, 'info');
  
  // If on trades page, reload and re-render
  if (currentSection === 'trades') {
    loadState().then(() => {
      renderTrades();
    });
  }
}

function _handleTradeCompleted(data) {
  // Handler for trade_completed event
  // Notifies involved managers that trade was approved
  
  if (!data || !data.tradeId) return;
  
  // Show toast notification
  toast(`Trade completed: ${data.fromTeam} ↔ ${data.toTeam}`, 'success');
  
  // If on trades page, reload and re-render
  if (currentSection === 'trades') {
    loadState().then(() => {
      renderTrades();
    });
  }
  
  // If on teams page, reload rosters
  if (currentSection === 'teams') {
    loadState().then(() => {
      renderTeams();
    });
  }
}

function _handleLiveEvent(evt) {
  let msg;
  try { msg = JSON.parse(evt.data); } catch { return; }
  const { type, data } = msg;

  // Visual indicator for live updates
  _showLiveUpdateIndicator(type);

  // Suppress echo: if we saved within the last 1.5s, our own change just
  // round-tripped. Don't pull and re-render.
  if (type === 'state_updated' && (Date.now() - _lastSelfSaveAt) < 1500) {
    console.log('[Live] Echo suppressed - ignoring state_updated');
    return;
  }

  switch (type) {
    case 'connected':
      console.log('[Live] SSE connected');
      break;
    case 'state_updated':
      console.log('[Live] state_updated — refreshing');
      _liveReloadState();
      break;
    case 'draft_pick':
      // Legacy event - still reload for backwards compatibility
      console.log('[Live] draft_pick (legacy)', data);
      _liveReloadState();
      toast(`Pick: ${data?.pick?.playerName || 'player'}`, 'info');
      break;
    case 'draft_pick_made':
      // Optimized draft event - targeted update
      console.log('[Live] draft_pick_made', data);
      _handleDraftPickMade(data);
      break;
    case 'trade_proposed':
      // New trade proposal
      console.log('[Live] trade_proposed', data);
      _handleTradeProposed(data);
      break;
    case 'trade_completed':
      // Trade was approved and applied
      console.log('[Live] trade_completed', data);
      _handleTradeCompleted(data);
      break;
    case 'trade_applied':
      // Legacy event - still reload for backwards compatibility
      console.log('[Live] trade_applied (legacy)', data);
      _liveReloadState();
      toast('Trade applied', 'success');
      break;
    case 'score_updated':
      // Enhanced score event with full data
      console.log('[Live] score_updated', data);
      _handleScoreUpdated(data);
      break;
    case 'score_approved':
      // Score was approved by admin
      console.log('[Live] score_approved', data);
      _handleScoreApproved(data);
      break;
    case 'pending_new':
      console.log('[Live] pending_new', data);
      // Refresh the admin pending panel if it's loaded
      try {
        if (typeof refreshPendingList === 'function') refreshPendingList();
        if (typeof window !== 'undefined' && typeof window.loadPendingCount === 'function') window.loadPendingCount();
      } catch {}
      if (isAdmin) toast(`New ${data?.type || 'request'} pending`, 'info');
      break;
    default:
      // Unknown event, ignore
      break;
  }
}

function _connectSSE() {
  try {
    if (_sseSource) { try { _sseSource.close(); } catch {} }
    _sseSource = new EventSource('/api/events');
    _sseSource.onmessage = _handleLiveEvent;
    _sseSource.onopen = () => { _sseReconnectDelay = 1000; };
    _sseSource.onerror = () => {
      // EventSource auto-reconnects, but if the server drops we want a backoff
      try { _sseSource.close(); } catch {}
      _sseSource = null;
      const delay = Math.min(_sseReconnectDelay, 15000);
      console.warn(`[Live] SSE disconnected, retrying in ${delay}ms`);
      setTimeout(_connectSSE, delay);
      _sseReconnectDelay = Math.min(_sseReconnectDelay * 2, 15000);
    };
  } catch (err) {
    console.warn('[Live] failed to open EventSource:', err);
  }
}

// Visual indicator for live updates
let _indicatorQueue = [];
let _indicatorShowing = false;

function _showLiveUpdateIndicator(eventType) {
  if (eventType === 'connected') return; // Skip connection events
  
  // Skip state_updated if we just showed a more specific event
  if (eventType === 'state_updated' && _indicatorQueue.length > 0) return;
  
  const icons = {
    'score_updated': '⚽',
    'score_approved': '✅',
    'trade_proposed': '📩',
    'trade_completed': '🤝',
    'trade_applied': '🤝',
    'draft_pick': '🎯',
    'draft_pick_made': '🎯',
    'state_updated': '💾',
    'pending_new': '🔔'
  };
  const labels = {
    'score_updated': 'Score Updated',
    'score_approved': 'Score Approved',
    'trade_proposed': 'Trade Proposed',
    'trade_completed': 'Trade Completed',
    'trade_applied': 'Trade Applied',
    'draft_pick': 'Draft Pick',
    'draft_pick_made': 'Draft Pick',
    'state_updated': 'Data Updated',
    'pending_new': 'New Pending'
  };
  
  const icon = icons[eventType] || '📡';
  const label = labels[eventType] || 'Live Update';
  
  _indicatorQueue.push({ icon, label });
  
  if (!_indicatorShowing) {
    _showNextIndicator();
  }
}

function _showNextIndicator() {
  if (_indicatorQueue.length === 0) {
    _indicatorShowing = false;
    return;
  }
  
  _indicatorShowing = true;
  const { icon, label } = _indicatorQueue.shift();
  
  // Create indicator if it doesn't exist
  let indicator = document.getElementById('live-update-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'live-update-indicator';
    indicator.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(102, 126, 234, 0.4);
      font-size: 14px;
      font-weight: 600;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
    `;
    document.body.appendChild(indicator);
  }
  
  indicator.textContent = `${icon} ${label}`;
  indicator.style.opacity = '1';
  
  // Fade out after 2 seconds, then show next
  setTimeout(() => {
    indicator.style.opacity = '0';
    setTimeout(_showNextIndicator, 300);
  }, 2000);
}

// Connect once the page is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _connectSSE);
} else {
  _connectSSE();
}

// ================================================================
// 2.  NHL TEAMS  (IDs match NHLView NG / SYS-DATA team records)
const NHL_TEAMS = [
  {id:0,  code:"ANA", name:"Anaheim Ducks"},
  {id:1,  code:"WPG", name:"Winnipeg Jets"},
  {id:2,  code:"BOS", name:"Boston Bruins"},
  {id:3,  code:"BUF", name:"Buffalo Sabres"},
  {id:4,  code:"CGY", name:"Calgary Flames"},
  {id:5,  code:"CAR", name:"Carolina Hurricanes"},
  {id:6,  code:"CHI", name:"Chicago Blackhawks"},
  {id:7,  code:"COL", name:"Colorado Avalanche"},
  {id:8,  code:"CBJ", name:"Columbus Blue Jackets"},
  {id:9,  code:"DAL", name:"Dallas Stars"},
  {id:10, code:"DET", name:"Detroit Red Wings"},
  {id:11, code:"EDM", name:"Edmonton Oilers"},
  {id:12, code:"FLA", name:"Florida Panthers"},
  {id:13, code:"LAK", name:"Los Angeles Kings"},
  {id:14, code:"MIN", name:"Minnesota Wild"},
  {id:15, code:"MTL", name:"Montreal Canadiens"},
  {id:16, code:"NSH", name:"Nashville Predators"},
  {id:17, code:"NJD", name:"New Jersey Devils"},
  {id:18, code:"NYI", name:"NY Islanders"},
  {id:19, code:"NYR", name:"NY Rangers"},
  {id:20, code:"OTT", name:"Ottawa Senators"},
  {id:21, code:"PHI", name:"Philadelphia Flyers"},
  {id:22, code:"UTA", name:"Utah Hockey Club"},
  {id:23, code:"PIT", name:"Pittsburgh Penguins"},
  {id:24, code:"STL", name:"St. Louis Blues"},
  {id:25, code:"SJS", name:"San Jose Sharks"},
  {id:26, code:"TBL", name:"Tampa Bay Lightning"},
  {id:27, code:"TOR", name:"Toronto Maple Leafs"},
  {id:28, code:"VAN", name:"Vancouver Canucks"},
  {id:29, code:"WSH", name:"Washington Capitals"},
  {id:30, code:"VGK", name:"Vegas Golden Knights"},
  {id:31, code:"SEA", name:"Seattle Kraken"},
];

// Primary brand color per team — used in box score bars & donut charts.
// Picked for readability on dark backgrounds; secondary color used where
// the true primary is too dark (e.g. navy teams get their accent).
const NHL_TEAM_COLORS = {
  ANA: '#F47A38',  // Ducks orange
  BOS: '#FFB81C',  // Bruins gold
  BUF: '#003E7E',  // Sabres royal blue
  CGY: '#C8102E',  // Flames red
  CAR: '#CC0000',  // Hurricanes red
  CHI: '#CF0A2C',  // Blackhawks red
  COL: '#6F263D',  // Avalanche burgundy
  CBJ: '#CE1126',  // Blue Jackets red
  DAL: '#006847',  // Stars victory green
  DET: '#CE1126',  // Red Wings red
  EDM: '#FF4C00',  // Oilers orange
  FLA: '#B9975B',  // Panthers gold (avoids clash with too many reds)
  LAK: '#A2AAAD',  // Kings silver
  MIN: '#A6192E',  // Wild red
  MTL: '#AF1E2D',  // Canadiens red
  NSH: '#FFB81C',  // Predators gold
  NJD: '#CE1126',  // Devils red
  NYI: '#F47D30',  // Islanders orange
  NYR: '#0038A8',  // Rangers blue
  OTT: '#E31837',  // Senators red
  PHI: '#F74902',  // Flyers orange
  PIT: '#FCB514',  // Penguins gold
  SEA: '#99D9D9',  // Kraken ice blue
  SJS: '#00B2A9',  // Sharks teal
  STL: '#0038A8',  // Blues royal blue
  TBL: '#2563A8',  // Lightning blue (lighter for dark bg)
  TOR: '#00205B',  // Leafs navy — use accent
  UTA: '#69B3E7',  // Utah Hockey Club sky blue
  VAN: '#00843D',  // Canucks green
  VGK: '#B4975A',  // Golden Knights gold
  WSH: '#C8102E',  // Capitals red
  WPG: '#004C97',  // Jets blue
};
// Fallback for any unmapped code
function teamColor(code) { return NHL_TEAM_COLORS[code] || '#5b8fc9'; }

// League defaults — 32 managers mapped to their teams
const LEAGUE_DEFAULTS = {
  managers: [
    "Girgs","Buckwest","gilleh","Nordet","Justo","hamlyn","Zam","Dambo",
    "RobotSp","JerDubz","FagelBob","Jes","Raymond","Dats","Tino45","Dmitry",
    "Thor","dannypet","Jasper","Sebbest","cdnbud","Elensar","Jawnmuff","Steeliest",
    "Jefrosteel","Beniers","Moodo","Eggbert","blake1288","Palbo","DDP","Bacon",
  ],
  teamMap: {
    "Girgs":"TBL","Buckwest":"CAR","gilleh":"DET","Nordet":"MTL","Justo":"STL",
    "hamlyn":"EDM","Zam":"PIT","Dambo":"CHI","RobotSp":"NYR","JerDubz":"FLA",
    "FagelBob":"NSH","Jes":"DAL","Raymond":"VAN","Dats":"MIN","Tino45":"SEA",
    "Dmitry":"OTT","Thor":"WSH","dannypet":"UTA","Jasper":"LAK","Sebbest":"NYI",
    "cdnbud":"BOS","Elensar":"NJD","Jawnmuff":"PHI","Steeliest":"BUF",
    "Jefrosteel":"VGK","Beniers":"CGY","Moodo":"TOR","Eggbert":"WPG",
    "blake1288":"CBJ","Palbo":"SJS","DDP":"ANA","Bacon":"COL",
  },
};
const TEAM_ID_MAP = Object.fromEntries(NHL_TEAMS.map(t => [t.id, t.code]));
const TEAM_CODE_MAP = Object.fromEntries(NHL_TEAMS.map(t => [t.code, t]));
const MANAGER_COLORS = ["#CE1126","#1f6feb","#3fb950","#d29922","#a371f7","#39d353","#58a6ff","#f78166","#79c0ff","#ffa657","#ff7b72","#56d364"];

// ================================================================
// 4.  STATE MANAGEMENT
// ================================================================
const STORAGE_KEY = 'nhl-legacy-league-v2';

const defaultState = () => ({
  league:        { name: 'NHL Legacy League', season: '', adminHash: '', draftEnabled: false },
  managers:      [],        // [{id, name, color}]
  teamOwners:    {},        // {teamCode: managerId}
  players:       [],        // from NHL API: [{id, name, teamCode, position, headshot, number}]
  games:         [],        // [{id, date, homeTeam, awayTeam, homeScore, awayScore, played, ot, notes}]
  draft:         { active: false, rounds: 1, order: [], picks: [] },
  playerDraft:   [],        // [{round, teamCode, player}] — imported from spreadsheet CSV
  draftTab:      'live',    // 'live' | 'imported' | 'team'
  liveDraft:     { active: false, rounds: 1, order: [], picks: [], autoManagers: [] },
  playoffs:      null,      // { rounds: [{name, week, series: [{team1,team2,wins1,wins2,winner}]}] }
  trades:        [],        // [{id, date, fromTeam, toTeam, playersSent, playersReceived, notes}]
  lines:         {},        // {teamCode: {F1:{LW,C,RW}, D1:{LD,RD}, G1:{G}, PP1:{...}, PK1:{...}}}
  currentSeason:  1,         // season counter
  currentWeek:    null,      // admin-set week override (null = auto-calculate)
  seasons:        [],        // saved season snapshots
  sysDataFile:        null,  // { name, filename, size, uploadedAt, week }
  teamCoOwners:       {},    // {teamCode: managerId} — secondary manager per team
  scheduleStartDate:  null,  // ISO date string for Week 1 start (used for week label display)
  rules:              null,  // league rules markdown string (null = use default)
  discordConfig: {           // Discord bot channel/notification settings
    scoresChannel:  '',      // Channel ID (string) where approved scores are posted
    tradesChannel:  '',      // Channel ID (string) where approved trades are posted
    pendingChannel: '',      // Channel ID (string) for pending approval posts (alternative to admin DMs)
    adminDm:        true,    // DM each admin role member for approval requests
  },
  playoffFormat: [           // configurable per-round series length
    { name: 'First Round',       winTo: 2 },  // Bo3
    { name: 'Second Round',      winTo: 3 },  // Bo5
    { name: 'Conference Finals', winTo: 3 },  // Bo5
    { name: 'Championship',      winTo: 4 },  // Bo7
  ],
});

let state = defaultState();
let isAdmin = false;
let currentSection = 'dashboard';
let _adminToken = sessionStorage.getItem('nhl-admin-token') || '';
let _portalSession = defaultPortalSession();
let _portalGames = [];
let _portalLinkOptions = [];
let _portalBusy = false;
let _portalMatchCache = {};
let _portalMatchInflight = {};
let _portalTradesBadgeAt = 0;
let _portalTradesCache = null;
let _portalTradesInflight = null;
let _apiAvailable = false;    // true once we've successfully talked to /api/state
let _zamboniPlayers = null;   // cached gamertag list from /api/zamboni/players
let _zbCache     = null;      // cached { tagMap, gameMap, mgrRecord } for box scores
let _zbCacheAt   = 0;
let _tradeValuesLoaded = false;
const _ZB_TTL        = 30 * 60 * 1000; // 30-min in-memory cache
const _ZB_SS_KEY     = 'nhl_zb_cache';  // sessionStorage key
const _PORTAL_MATCH_CACHE_KEY = 'nhl_portal_match_cache';
const _PORTAL_MATCH_CACHE_TTL = 10 * 60 * 1000;
const _statSort        = { col: 'pts', dir: -1 }; // Stats leaderboard sort state
let _settingsSection = null;                  // null = menu, string = active section id

function normalizeSysDataFile(file) {
  if (!file) return null;
  const name = file.name || file.filename || 'SYS-DATA';
  const normalized = {
    ...file,
    name,
    filename: file.filename || name,
  };
  delete normalized.data;
  return normalized;
}

function resolvePlayerName(playerRef, fallbackPrefix = '#') {
  if (typeof playerRef === 'string') return playerRef;
  const ref = String(playerRef ?? '').trim();
  if (!ref) return `${fallbackPrefix}?`;
  const match = state.players.find(p => String(p.id) === ref);
  return match?.name || `${fallbackPrefix}${ref}`;
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function _apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (_adminToken) headers['Authorization'] = `Bearer ${_adminToken}`;
  return fetch(path, { ...opts, headers });
}

async function _portalFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const hasBody = opts.body !== undefined && opts.body !== null;
  if (hasBody && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (!headers['Accept']) headers['Accept'] = 'application/json';
  return fetch(path, { ...opts, headers, cache: 'no-store' });
}

async function loadPortalGames() {
  if (!_portalSession?.user || !_portalSession?.linked) {
    _portalGames = [];
    return [];
  }
  try {
    const r = await _portalFetch('/api/v2/me/score/games');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      _portalGames = [];
      return [];
    }
    _portalGames = Array.isArray(body.games) ? body.games : [];
    if (body.manager) _portalSession.manager = body.manager;
    if (body.teamCode) _portalSession.teamCode = body.teamCode;
    if (body.currentWeek != null) _portalSession.currentWeek = body.currentWeek;
    prefetchPortalMatches(_portalGames);
    return _portalGames;
  } catch {
    _portalGames = [];
    return [];
  }
}

async function fetchPortalMatches(gameId, { preferCache = true } = {}) {
  if (preferCache) {
    const cached = getCachedPortalMatches(gameId);
    if (cached) return cached;
  }
  const inflight = getInflightPortalMatches(gameId);
  if (inflight) return inflight;
  const request = (async () => {
    const r = await _portalFetch(`/api/v2/me/score/matches/${encodeURIComponent(gameId)}`);
    const body = await r.json().catch(() => ({}));
    const result = { ...body, _ok: r.ok, _status: r.status };
    if (r.ok) setCachedPortalMatches(gameId, body);
    return result;
  })();
  setInflightPortalMatches(gameId, request);
  try {
    return await request;
  } finally {
    clearInflightPortalMatches(gameId);
  }
}

function prefetchPortalMatches(games = []) {
  if (!_portalSession?.linked || !Array.isArray(games) || !games.length) return;
  const targets = games.slice(0, 2).filter(g => !getCachedPortalMatches(g.id));
  targets.forEach(g => {
    fetchPortalMatches(g.id, { preferCache: true }).catch(() => null);
  });
}

async function loadPortalLinkOptions() {
  if (!_portalSession?.user) {
    _portalLinkOptions = [];
    return [];
  }
  try {
    const r = await _portalFetch('/api/v2/me/link-options');
    const body = await r.json().catch(() => ({}));
    _portalLinkOptions = r.ok && Array.isArray(body.managers) ? body.managers : [];
    return _portalLinkOptions;
  } catch {
    _portalLinkOptions = [];
    return [];
  }
}

function portalDisplayName() {
  return _portalSession?.user?.globalName || _portalSession?.user?.username || 'Discord user';
}

function portalAvatar() {
  return _portalSession?.user?.avatar || _portalSession?.manager?.discordAvatar || '';
}

function portalGameLabel(g) {
  const week = g.week || '?';
  if (week >= 100) {
    const round = g.roundLabel || `Playoffs Rd ${week - 99}`;
    return `${round}${g.notes ? ` · ${g.notes}` : ''}`;
  }
  return `Week ${week}`;
}

function portalGameSummary(g) {
  return `${g.homeTeam} vs ${g.awayTeam}`;
}

// Portal login/logout/link handlers moved to portal-ui.js

function openPortalScoreModal(gameId) {
  const game = _portalGames.find(g => String(g.id) === String(gameId));
  if (!game) {
    toast('Game not found', 'error');
    return;
  }
  openPortalManualScoreModal(game);
}

function openPortalManualScoreModal(game) {
  showModal(`Submit Score — ${portalGameSummary(game)}`, `
    <div class="form-row">
      <label>${game.homeTeam} score</label>
      <input type="number" id="portal-home-score" min="0" max="99" inputmode="numeric" placeholder="3">
    </div>
    <div class="form-row">
      <label>${game.awayTeam} score</label>
      <input type="number" id="portal-away-score" min="0" max="99" inputmode="numeric" placeholder="1">
    </div>
    <div class="form-row">
      <label class="portal-checkbox-row"><input type="checkbox" id="portal-ot-check"> Overtime / shootout</label>
    </div>
    <div class="portal-score-meta">
      <div>${portalGameLabel(game)}</div>
      <div>${game.homeManagerName || '—'} vs ${game.awayManagerName || '—'}</div>
    </div>
    ${FEATURE_FLAGS.ENABLE_MANUAL_STATS ? `
      <button id="modal-ok" class="btn btn-primary btn-block mt-12">Next: Add Player Stats (Optional)</button>
      <button id="portal-skip-stats-btn" class="btn btn-ghost btn-block mt-8" type="button">Skip Stats & Submit</button>
    ` : `
      <button id="modal-ok" class="btn btn-primary btn-block mt-12">Submit Score</button>
    `}
  `, async () => {
    const hs = parseInt($('portal-home-score')?.value, 10);
    const as = parseInt($('portal-away-score')?.value, 10);
    const ot = !!$('portal-ot-check')?.checked;
    if (!Number.isFinite(hs) || !Number.isFinite(as)) {
      toast('Enter both scores', 'error');
      return;
    }
    if (hs === as) {
      toast('Scores cannot be tied', 'error');
      return;
    }
    
    // If manual stats enabled, go to stats entry. Otherwise submit directly.
    if (FEATURE_FLAGS.ENABLE_MANUAL_STATS) {
      openPortalPlayerStatsModal(game, hs, as, ot);
    } else {
      try {
        await submitPortalScorePayload({ gameId: game.id, homeScore: hs, awayScore: as, ot });
        hideModal();
      } catch {
        toast('Could not submit score', 'error');
      }
    }
  });
  $('portal-skip-stats-btn')?.addEventListener('click', async () => {
    const hs = parseInt($('portal-home-score')?.value, 10);
    const as = parseInt($('portal-away-score')?.value, 10);
    const ot = !!$('portal-ot-check')?.checked;
    if (!Number.isFinite(hs) || !Number.isFinite(as)) {
      toast('Enter both scores', 'error');
      return;
    }
    if (hs === as) {
      toast('Scores cannot be tied', 'error');
      return;
    }
    const btn = $('portal-skip-stats-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Submitting…';
    }
    try {
      await submitPortalScorePayload({ gameId: game.id, homeScore: hs, awayScore: as, ot });
      hideModal();
    } catch {
      toast('Could not submit score', 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Skip Stats & Submit';
      }
    }
  });
}

function openPortalPlayerStatsModal(game, homeScore, awayScore, ot) {
  const homeRoster = state.players.filter(p => p.teamCode === game.homeTeam);
  const awayRoster = state.players.filter(p => p.teamCode === game.awayTeam);
  
  // Separate goalies from skaters
  const homeGoalies = homeRoster.filter(p => p.position === 'G');
  const awayGoalies = awayRoster.filter(p => p.position === 'G');
  const homeSkaters = homeRoster.filter(p => p.position !== 'G');
  const awaySkaters = awayRoster.filter(p => p.position !== 'G');
  
  const skaterRow = (p, team) => `
    <tr data-player-id="${p.id}" data-team="${team}" data-position="skater">
      <td class="text-left"><strong>${p.name}</strong> <span class="text-xs text-muted">${p.position || ''}</span></td>
      <td><input type="number" class="stat-input stat-g" min="0" max="9" value="0" inputmode="numeric"></td>
      <td><input type="number" class="stat-input stat-a" min="0" max="9" value="0" inputmode="numeric"></td>
      <td><input type="number" class="stat-input stat-pm" min="-9" max="9" value="0" inputmode="numeric"></td>
      <td><input type="number" class="stat-input stat-pim" min="0" max="99" value="0" inputmode="numeric"></td>
    </tr>
  `;
  
  const goalieSelect = (goalies, team, opponentScore) => {
    if (!goalies || goalies.length === 0) {
      return '<tr><td colspan="6" class="text-dim text-center">No goalies on roster</td></tr>';
    }
    
    return `
      <tr data-team="${team}" data-position="goalie">
        <td class="text-left">
          <select class="goalie-select" data-team="${team}">
            <option value="">— Select Goalie —</option>
            ${goalies.map(g => `<option value="${g.id}">${g.name}</option>`).join('')}
          </select>
        </td>
        <td><input type="number" class="stat-input stat-sa" min="0" max="99" value="0" inputmode="numeric" placeholder="0" disabled></td>
        <td><input type="number" class="stat-input stat-sv" min="0" max="99" value="0" inputmode="numeric" placeholder="0" disabled></td>
        <td><input type="number" class="stat-input stat-ga" min="0" max="99" value="${opponentScore}" inputmode="numeric" disabled></td>
        <td class="stat-svp">—</td>
        <td><label class="stat-so-check"><input type="checkbox" class="stat-so" disabled> SO</label></td>
      </tr>
    `;
  };
  
  showModal(`Player Stats — ${portalGameSummary(game)}`, `
    <div class="portal-stats-upload-section mb-12">
      <p class="text-xs text-muted mb-8">Upload screenshots for automatic stat extraction (optional)</p>
      <div class="form-row">
        <label>Box Score Screenshot</label>
        <input type="file" id="portal-box-score-upload" accept="image/*" class="file-input">
        <p class="text-xs text-muted">Goal summary screen from NHL Legacy</p>
      </div>
      <div class="form-row">
        <label>Detailed Stats Screenshot (optional)</label>
        <input type="file" id="portal-stats-upload" accept="image/*" class="file-input">
        <p class="text-xs text-muted">Full player stats table (shots, hits, +/-, etc.)</p>
      </div>
      <button id="portal-process-ocr-btn" class="btn btn-secondary btn-sm" type="button" disabled>Process Screenshots</button>
    </div>
    
    <div class="portal-stats-manual-section">
      <p class="text-xs text-muted mb-8">Or enter stats manually (only fill in players who contributed)</p>
      
      <!-- HOME TEAM -->
      <h4 class="text-sm font-bold mb-4 mt-16">${game.homeTeam} Goalies</h4>
      <div class="table-wrap mb-12">
        <table class="portal-stats-table">
          <thead>
            <tr>
              <th class="text-left">Goalie</th>
              <th>SA</th>
              <th>SV</th>
              <th>GA</th>
              <th>SV%</th>
              <th>SO</th>
            </tr>
          </thead>
          <tbody id="home-goalies-body">
            ${goalieSelect(homeGoalies, game.homeTeam, awayScore)}
          </tbody>
        </table>
      </div>
      
      <h4 class="text-sm font-bold mb-4">${game.homeTeam} Skaters</h4>
      <div class="table-wrap mb-12" style="max-height:200px;overflow-y:auto">
        <table class="portal-stats-table">
          <thead>
            <tr>
              <th class="text-left">Player</th>
              <th>G</th>
              <th>A</th>
              <th>+/-</th>
              <th>PIM</th>
            </tr>
          </thead>
          <tbody>
            ${homeSkaters.map(p => skaterRow(p, game.homeTeam)).join('')}
          </tbody>
        </table>
      </div>
      
      <!-- AWAY TEAM -->
      <h4 class="text-sm font-bold mb-4 mt-16">${game.awayTeam} Goalies</h4>
      <div class="table-wrap mb-12">
        <table class="portal-stats-table">
          <thead>
            <tr>
              <th class="text-left">Goalie</th>
              <th>SA</th>
              <th>SV</th>
              <th>GA</th>
              <th>SV%</th>
              <th>SO</th>
            </tr>
          </thead>
          <tbody id="away-goalies-body">
            ${goalieSelect(awayGoalies, game.awayTeam, homeScore)}
          </tbody>
        </table>
      </div>
      
      <h4 class="text-sm font-bold mb-4">${game.awayTeam} Skaters</h4>
      <div class="table-wrap mb-12" style="max-height:200px;overflow-y:auto">
        <table class="portal-stats-table">
          <thead>
            <tr>
              <th class="text-left">Player</th>
              <th>G</th>
              <th>A</th>
              <th>+/-</th>
              <th>PIM</th>
            </tr>
          </thead>
          <tbody>
            ${awaySkaters.map(p => skaterRow(p, game.awayTeam)).join('')}
          </tbody>
        </table>
      </div>
    </div>
    
    <button id="modal-ok" class="btn btn-primary btn-block mt-12">Submit Score with Stats</button>
    <button id="portal-submit-no-stats-btn" class="btn btn-ghost btn-block mt-8" type="button">Submit Without Stats</button>
  `, async () => {
    const playerStats = collectPlayerStats();
    
    // Validate stats match the score
    const validation = validatePlayerStats(playerStats, game.homeTeam, game.awayTeam, homeScore, awayScore);
    if (!validation.valid) {
      toast(validation.error, 'error');
      return;
    }
    
    const btn = $('modal-ok');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Submitting…';
    }
    try {
      await submitPortalScorePayload({
        gameId: game.id,
        homeScore,
        awayScore,
        ot,
        playerStats,
        statsSource: 'manual'
      });
      hideModal();
    } catch {
      toast('Could not submit score', 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Submit Score with Stats';
      }
    }
  });
  
  // Enable OCR button when files are selected
  const boxScoreInput = $('portal-box-score-upload');
  const statsInput = $('portal-stats-upload');
  const ocrBtn = $('portal-process-ocr-btn');
  
  const checkFiles = () => {
    if (ocrBtn) {
      ocrBtn.disabled = !boxScoreInput?.files?.length && !statsInput?.files?.length;
    }
  };
  
  boxScoreInput?.addEventListener('change', checkFiles);
  statsInput?.addEventListener('change', checkFiles);
  
  // Enable goalie stats inputs when goalie is selected
  document.querySelectorAll('.goalie-select').forEach(select => {
    const row = select.closest('tr');
    const inputs = row.querySelectorAll('.stat-input, .stat-so');
    
    select.addEventListener('change', () => {
      const selected = select.value;
      inputs.forEach(input => {
        input.disabled = !selected;
      });
      
      // Set player ID on the row
      if (selected) {
        row.dataset.playerId = selected;
      } else {
        delete row.dataset.playerId;
      }
    });
  });
  
  // Auto-calculate save percentage for goalies
  document.querySelectorAll('[data-position="goalie"]').forEach(row => {
    const saInput = row.querySelector('.stat-sa');
    const svInput = row.querySelector('.stat-sv');
    const svpCell = row.querySelector('.stat-svp');
    
    const updateSvp = () => {
      const sa = parseInt(saInput?.value, 10) || 0;
      const sv = parseInt(svInput?.value, 10) || 0;
      if (sa > 0) {
        const svp = (sv / sa * 100).toFixed(1);
        svpCell.textContent = `.${svp.replace('.', '').padStart(3, '0')}`;
      } else {
        svpCell.textContent = '—';
      }
    };
    
    saInput?.addEventListener('input', updateSvp);
    svInput?.addEventListener('input', updateSvp);
  });
  
  ocrBtn?.addEventListener('click', async () => {
    ocrBtn.disabled = true;
    ocrBtn.textContent = 'Processing...';
    try {
      await processStatsScreenshots(boxScoreInput, statsInput);
      toast('Stats extracted! Review and adjust if needed.', 'success');
    } catch (err) {
      toast(err.message || 'OCR processing failed', 'error');
    } finally {
      ocrBtn.disabled = false;
      ocrBtn.textContent = 'Process Screenshots';
    }
  });
  
  $('portal-submit-no-stats-btn')?.addEventListener('click', async () => {
    const btn = $('portal-submit-no-stats-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Submitting…';
    }
    try {
      await submitPortalScorePayload({ gameId: game.id, homeScore, awayScore, ot });
      hideModal();
    } catch {
      toast('Could not submit score', 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Submit Without Stats';
      }
    }
  });
}

function collectPlayerStats() {
  const stats = [];
  document.querySelectorAll('[data-player-id]').forEach(row => {
    const playerId = row.dataset.playerId;
    const team = row.dataset.team;
    const position = row.dataset.position;
    
    if (position === 'goalie') {
      // Goalie stats
      const sa = parseInt(row.querySelector('.stat-sa')?.value, 10) || 0;
      const sv = parseInt(row.querySelector('.stat-sv')?.value, 10) || 0;
      const ga = parseInt(row.querySelector('.stat-ga')?.value, 10) || 0;
      const so = row.querySelector('.stat-so')?.checked || false;
      
      // Only include goalies with non-zero stats
      if (sa || sv || ga) {
        const svp = sa > 0 ? (sv / sa) : 0;
        stats.push({
          playerId,
          teamCode: team,
          position: 'G',
          shotsAgainst: sa,
          saves: sv,
          goalsAgainst: ga,
          savePercentage: svp,
          shutout: so,
          timeOnIce: 0
        });
      }
    } else {
      // Skater stats
      const g = parseInt(row.querySelector('.stat-g')?.value, 10) || 0;
      const a = parseInt(row.querySelector('.stat-a')?.value, 10) || 0;
      const pm = parseInt(row.querySelector('.stat-pm')?.value, 10) || 0;
      const pim = parseInt(row.querySelector('.stat-pim')?.value, 10) || 0;
      
      // Only include players with non-zero stats
      if (g || a || pm || pim) {
        stats.push({
          playerId,
          teamCode: team,
          position: 'skater',
          goals: g,
          assists: a,
          points: g + a,
          plusMinus: pm,
          pim,
          shots: 0,
          hits: 0,
          blockedShots: 0,
          faceoffWins: 0,
          faceoffLosses: 0,
          timeOnIce: 0
        });
      }
    }
  });
  return stats;
}

function validatePlayerStats(playerStats, homeTeam, awayTeam, homeScore, awayScore) {
  if (!playerStats || playerStats.length === 0) {
    return { valid: true }; // No stats to validate
  }
  
  const skaters = playerStats.filter(p => p.position !== 'G');
  const goalies = playerStats.filter(p => p.position === 'G');
  
  // Validate skater goals match the score
  const homeGoals = skaters.filter(p => p.teamCode === homeTeam).reduce((sum, p) => sum + (p.goals || 0), 0);
  const awayGoals = skaters.filter(p => p.teamCode === awayTeam).reduce((sum, p) => sum + (p.goals || 0), 0);
  
  if (homeGoals !== homeScore) {
    return {
      valid: false,
      error: `${homeTeam} player goals (${homeGoals}) don't match final score (${homeScore})`
    };
  }
  
  if (awayGoals !== awayScore) {
    return {
      valid: false,
      error: `${awayTeam} player goals (${awayGoals}) don't match final score (${awayScore})`
    };
  }
  
  // Validate assists (max 2 per goal)
  const totalGoals = homeGoals + awayGoals;
  const totalAssists = skaters.reduce((sum, p) => sum + (p.assists || 0), 0);
  
  if (totalAssists > totalGoals * 2) {
    return {
      valid: false,
      error: `Too many assists (${totalAssists}) for ${totalGoals} goals (max ${totalGoals * 2})`
    };
  }
  
  // Validate goalie stats
  for (const goalie of goalies) {
    const sa = goalie.shotsAgainst || 0;
    const sv = goalie.saves || 0;
    const ga = goalie.goalsAgainst || 0;
    const opponentScore = goalie.teamCode === homeTeam ? awayScore : homeScore;
    
    // GA must match opponent's score
    if (ga !== opponentScore) {
      return {
        valid: false,
        error: `Goalie GA (${ga}) doesn't match opponent score (${opponentScore})`
      };
    }
    
    // Saves + GA must equal SA
    if (sv + ga !== sa) {
      return {
        valid: false,
        error: `Goalie stats invalid: Saves (${sv}) + GA (${ga}) ≠ SA (${sa})`
      };
    }
    
    // SA must be >= GA
    if (sa < ga) {
      return {
        valid: false,
        error: `Goalie SA (${sa}) cannot be less than GA (${ga})`
      };
    }
  }
  
  return { valid: true };
}

async function processStatsScreenshots(boxScoreInput, statsInput) {
  const toBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  
  const boxScoreFile = boxScoreInput?.files?.[0];
  const statsFile = statsInput?.files?.[0];
  
  if (!boxScoreFile && !statsFile) {
    throw new Error('No screenshots selected');
  }
  
  const boxScoreBase64 = boxScoreFile ? await toBase64(boxScoreFile) : null;
  const statsBase64 = statsFile ? await toBase64(statsFile) : null;
  
  // TODO: Call OCR API endpoint
  // For now, just show a message
  throw new Error('OCR processing not yet implemented - please enter stats manually');
}

async function submitPortalScorePayload(payload) {
  const r = await _portalFetch('/api/v2/me/score', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(body.error || 'Could not submit score');
  }
  state = await loadState();
  await loadPortalSession();
  _portalTradesBadgeAt = 0;
  clearCachedPortalTrades();
  updatePortalUI();
  renderSection(currentSection);
  toast('Score submitted successfully', 'success');
  return body;
}

function openPortalZamboniMatchModal(game, matchData) {
  const matches = Array.isArray(matchData?.matches) ? matchData.matches : [];
  const options = matches.map(m => `<option value="${m.gameId}">${m.label}</option>`).join('');
  showModal(`Pick Zamboni Match — ${portalGameSummary(game)}`, `
    <div class="portal-score-meta" style="margin-bottom:10px">
      <div>${matchData.homeTag} vs ${matchData.awayTag}</div>
      <div>${matches.length} Zamboni match${matches.length === 1 ? '' : 'es'} found</div>
    </div>
    <div class="form-row">
      <label>Zamboni match</label>
      <select id="portal-zamboni-match-select">${options}</select>
    </div>
    <div class="form-row">
      <label class="portal-checkbox-row"><input type="checkbox" id="portal-zamboni-ot-check"> Mark as overtime / shootout</label>
    </div>
    <button id="modal-ok" class="btn btn-primary btn-block mt-12">Use This Match</button>
    <button id="portal-manual-fallback-btn" class="btn btn-ghost btn-block mt-8" type="button">Enter Score Manually</button>
  `, async () => {
    const selected = $('portal-zamboni-match-select')?.value;
    const match = matches.find(m => String(m.gameId) === String(selected));
    if (!match) {
      toast('Pick a Zamboni match', 'error');
      return;
    }
    const btn = $('modal-ok');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Submitting…';
    }
    try {
      await submitPortalScorePayload({
        gameId: game.id,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        ot: !!$('portal-zamboni-ot-check')?.checked,
        zamboniGameId: match.gameId,
        zamboniStats: match.zamboniStats,
      });
      hideModal();
    } catch (err) {
      toast(err.message || 'Could not submit score', 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Use This Match';
      }
    }
  });
  const otCheck = $('portal-zamboni-ot-check');
  if (otCheck) otCheck.checked = false;
  $('portal-manual-fallback-btn')?.addEventListener('click', () => openPortalManualScoreModal(game));
}

async function handlePortalGamePick(gameId) {
  const game = _portalGames.find(g => String(g.id) === String(gameId));
  if (!game) {
    toast('Game not found', 'error');
    return;
  }
  try {
    const body = await fetchPortalMatches(game.id, { preferCache: true });
    if (body._ok !== false && Array.isArray(body.matches) && body.matches.length) {
      openPortalZamboniMatchModal(game, body);
      return;
    }
  } catch {}
  openPortalManualScoreModal(game);
}

// Trade proposal UI moved to portal-ui.js

// Trade display and submission moved to portal-ui.js

function portalCardHTML() {
  if (!_portalSession?.user) {
    return `
      <div class="panel portal-panel portal-panel-cta">
        <div class="conf-header">
          <span class="conf-title">🏒 Player Portal</span>
          <span class="conf-sub">Fast mobile score submission</span>
        </div>
        <div class="panel-body portal-panel-body">
          <p class="portal-copy">Sign in with Discord to link your manager account, view your games, and submit scores from your phone.</p>
          <button class="btn btn-primary btn-block" id="portal-login-btn">Sign Up with Discord</button>
        </div>
      </div>`;
  }
  const avatar = portalAvatar();
  const managerNameText = _portalSession?.manager?.name || 'Not linked yet';
  const teamCode = _portalSession?.teamCode || '—';
  const teamName = teamDisplayName(teamCode);
  if (!_portalSession.linked) {
    const managerOptions = _portalLinkOptions.length
      ? '<option value="">— Select your manager —</option>' + _portalLinkOptions.map(m => `<option value="${m.id}">${m.teamCode ? `${m.teamCode} · ` : ''}${m.name}</option>`).join('')
      : '<option value="">No available managers</option>';
    return `
      <div class="panel portal-panel">
        <div class="conf-header">
          <span class="conf-title">🔗 Link Your Team</span>
          <span class="conf-sub">Required before score submission</span>
        </div>
        <div class="panel-body portal-panel-body">
          <div class="portal-user-row">
            ${avatar ? `<img src="${avatar}" alt="" class="portal-avatar">` : '<div class="portal-avatar portal-avatar-fallback">D</div>'}
            <div>
              <div class="portal-user-name">${portalDisplayName()}</div>
              <div class="portal-user-sub">Signed in with Discord</div>
            </div>
          </div>
          <form id="portal-link-form" class="portal-link-form">
            <div class="form-row">
              <label>Manager</label>
              <select id="portal-manager-select">${managerOptions}</select>
            </div>
            <div class="form-row">
              <label>RPCN Account</label>
              <div class="zamboni-wrap">
                <input type="text" id="portal-zamboni-tag" placeholder="Enter your RPCN account" autocomplete="off" autocapitalize="off" spellcheck="false">
                <div id="portal-rpcn-drop" class="zamboni-drop"></div>
              </div>
              <div id="portal-rpcn-status" class="portal-rpcn-status">Start typing your RPCN account for suggestions.</div>
            </div>
            <button class="btn btn-primary btn-block" type="submit">Link Account</button>
          </form>
          <button class="btn btn-ghost btn-block" id="portal-logout-btn">Sign Out</button>
        </div>
      </div>`;
  }
  const standings = calcStandings();
  const teamSt = standings.find(s => s.teamCode === teamCode);
  const recordPlain = teamSt ? `${teamSt.w}-${teamSt.l}${teamSt.ot ? '-' + teamSt.ot : ''}` : '—';
  const teamRecords = Object.fromEntries(standings.map(s => [s.teamCode, `(${s.w}-${s.l}${s.ot ? '-' + s.ot : ''})`]));
  const teamLogo = teamCode ? teamLogoLg(teamCode, 96) : '';
  const gamesHtml = _portalGames.length
    ? `
      ${_portalGames.slice(0, 6).map(g => {
        const homeName = teamDisplayName(g.homeTeam);
        const awayName = teamDisplayName(g.awayTeam);
        const homeManager = g.homeManagerName || 'TBD';
        const awayManager = g.awayManagerName || 'TBD';
        const homeRecord = teamRecords[g.homeTeam] || '—';
        const awayRecord = teamRecords[g.awayTeam] || '—';
        return `
      <button class="portal-game-card" data-game-id="${g.id}">
        <div class="portal-game-top">
          <span class="portal-game-week">${portalGameLabel(g)}</span>
          <span class="portal-game-action">Tap to submit</span>
        </div>
        <div class="portal-game-matchup">
          <div class="portal-matchup-team portal-matchup-home">
            <div class="portal-matchup-logo">${teamLogoLg(g.homeTeam, 56)}</div>
            <div class="portal-matchup-text">
              <div class="portal-matchup-name">${homeName}</div>
              <div class="portal-matchup-record">${homeRecord}</div>
              <div class="portal-matchup-mgr">${homeManager}</div>
            </div>
          </div>
          <div class="portal-matchup-center">
            <span class="portal-matchup-vs">VS</span>
            <span class="portal-matchup-pill">${portalGameLabel(g)}</span>
          </div>
          <div class="portal-matchup-team portal-matchup-away">
            <div class="portal-matchup-text portal-matchup-text-right">
              <div class="portal-matchup-name">${awayName}</div>
              <div class="portal-matchup-record">${awayRecord}</div>
              <div class="portal-matchup-mgr">${awayManager}</div>
            </div>
            <div class="portal-matchup-logo">${teamLogoLg(g.awayTeam, 56)}</div>
          </div>
        </div>
      </button>`;
      }).join('')}
    `
    : '<div class="empty-state"><span class="empty-icon">✅</span>No eligible games to submit right now</div>';
  return `
    <div class="panel portal-panel portal-panel-live">
      <div class="conf-header">
        <span class="conf-title">📱 My Score Portal</span>
        <span class="conf-sub">Arena-style mobile score hub</span>
      </div>
      <div class="panel-body portal-panel-body">
        <div class="portal-user-row">
          ${avatar ? `<img src="${avatar}" alt="" class="portal-avatar">` : '<div class="portal-avatar portal-avatar-fallback">D</div>'}
          <div class="portal-user-meta">
            <div class="portal-user-kicker">Manager</div>
            <div class="portal-user-name portal-user-name-strong">${managerNameText}</div>
            <div class="portal-user-sub">${portalDisplayName()}</div>
          </div>
          <button class="btn btn-ghost btn-sm" id="portal-logout-btn">Sign Out</button>
        </div>
        <div class="portal-team-banner">
          <div class="portal-team-logo">${teamLogo}</div>
          <div class="portal-team-info">
            <div class="portal-team-name">${teamName}</div>
            <div class="portal-team-subline">${recordPlain}</div>
          </div>
        </div>
        <div class="portal-games-stack">${gamesHtml}</div>
        <div style="margin-top:16px;padding:0 16px 16px">
          <button class="btn btn-secondary btn-block" id="portal-propose-trade-btn">🔄 Propose Trade</button>
          <button class="btn btn-ghost btn-block" id="portal-my-trades-btn" style="margin-top:8px;position:relative">
            📋 My Trades
            <span id="portal-trades-badge" style="display:none;position:absolute;top:8px;right:12px;background:#e74c3c;color:#fff;padding:2px 6px;border-radius:10px;font-size:11px;font-weight:600;min-width:18px;text-align:center"></span>
          </button>
        </div>
      </div>
    </div>`;
}

// updatePortalTradesBadge moved to portal-ui.js

function bindPortalDashboardActions() {
  $('portal-login-btn')?.addEventListener('click', () => startPortalLogin());
  $('portal-logout-btn')?.addEventListener('click', handlePortalLogout);
  $('portal-link-form')?.addEventListener('submit', submitPortalLink);
  $('portal-propose-trade-btn')?.addEventListener('click', showProposeTrade);
  $('portal-my-trades-btn')?.addEventListener('click', showMyTrades);
  updatePortalTradesBadge();
  const rpcnInput = $('portal-zamboni-tag');
  const rpcnDrop = $('portal-rpcn-drop');
  if (rpcnInput) {
    loadZamboniPlayers().then(() => renderRpcnAutocomplete(rpcnInput.value));
    rpcnInput.addEventListener('input', () => renderRpcnAutocomplete(rpcnInput.value));
    rpcnInput.addEventListener('focus', () => renderRpcnAutocomplete(rpcnInput.value));
    rpcnInput.addEventListener('blur', () => {
      setTimeout(() => rpcnDrop?.classList.remove('open'), 120);
    });
  }
  document.querySelectorAll('.portal-game-card').forEach(btn => {
    btn.addEventListener('click', () => handlePortalGamePick(btn.dataset.gameId));
  });
}

function clearAdminSession({ rerender = false } = {}) {
  isAdmin = false;
  _adminToken = '';
  sessionStorage.removeItem('nhl-admin-token');
  updateAdminUI();
  if (rerender) renderSection(currentSection);
}

async function verifyAdminSession() {
  if (!_adminToken) {
    isAdmin = false;
    return false;
  }
  try {
    const r = await _apiFetch('api/auth/session', { method: 'GET' });
    if (!r.ok) {
      clearAdminSession();
      return false;
    }
    isAdmin = true;
    return true;
  } catch {
    clearAdminSession();
    return false;
  }
}

// Load state: try API first, fall back to localStorage
async function loadState() {
  try {
    const r = await _apiFetch('api/state');
    if (r.ok) {
      const data = await r.json();
      if (data && Object.keys(data).length) {
        _apiAvailable = true;
        const merged = { ...defaultState(), ...data };
        merged.sysDataFile = normalizeSysDataFile(merged.sysDataFile);
        // Keep localStorage in sync as a fast cache
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)); } catch {}
        return merged;
      }
    }
  } catch {}
  // API not available — use localStorage
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    const merged = s ? { ...defaultState(), ...JSON.parse(s) } : defaultState();
    merged.sysDataFile = normalizeSysDataFile(merged.sysDataFile);
    return merged;
  } catch { return defaultState(); }
}

// Save state: write to localStorage immediately, then async to API
function saveState() {
  state.sysDataFile = normalizeSysDataFile(state.sysDataFile);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  _lastSelfSaveAt = Date.now();  // suppress SSE echo refresh
  if (_apiAvailable) {
    _apiFetch('/api/state', { method: 'POST', body: JSON.stringify(state) })
      .catch(() => {});  // fire-and-forget; localStorage is the immediate fallback
  }
}

// ================================================================
// 5.  STANDINGS CALCULATION
// ================================================================
function calcStandings() {
  const map = {};
  for (const t of NHL_TEAMS) {
    map[t.code] = { teamCode: t.code, teamName: t.name, gp:0, w:0, l:0, ot:0, pts:0, gf:0, ga:0, rw:0 };
  }
  for (const g of state.games) {
    if (!g.played || g.playoff) continue;
    const h = g.homeTeam, a = g.awayTeam;
    if (!map[h]) map[h] = { teamCode:h, teamName:h, gp:0,w:0,l:0,ot:0,pts:0,gf:0,ga:0,rw:0 };
    if (!map[a]) map[a] = { teamCode:a, teamName:a, gp:0,w:0,l:0,ot:0,pts:0,gf:0,ga:0,rw:0 };
    const hs = +g.homeScore, as = +g.awayScore;
    map[h].gp++; map[a].gp++;
    map[h].gf += hs; map[h].ga += as;
    map[a].gf += as; map[a].ga += hs;
    if (g.ot) {
      if (hs > as) { map[h].w++; map[h].pts+=2; map[a].ot++; map[a].pts+=1; }
      else         { map[a].w++; map[a].pts+=2; map[h].ot++; map[h].pts+=1; }
    } else {
      if (hs > as) { map[h].w++; map[h].pts+=2; map[a].l++; map[h].rw++; }
      else         { map[a].w++; map[a].pts+=2; map[h].l++;  map[a].rw++; }
    }
  }
  // Only return teams that have played games or are in the league
  const activeCodes = new Set([
    ...state.games.map(g=>g.homeTeam),
    ...state.games.map(g=>g.awayTeam),
    ...Object.keys(state.teamOwners),
  ]);
  return Object.values(map)
    .filter(t => activeCodes.has(t.teamCode))
    .sort((a,b) => b.pts - a.pts || (b.gf-b.ga)-(a.gf-a.ga));
}

// ================================================================
// 6.  UI UTILITIES
// ================================================================
function $(id)   { return document.getElementById(id); }
function el(tag, cls, html='') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

function toast(msg, type='info') {
  const t = el('div', `toast toast-${type}`, msg);
  $('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function showModal(title, bodyHTML, onOk) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHTML;
  $('modal-overlay').classList.remove('hidden');
  if (onOk) {
    const btn = $('modal-body').querySelector('#modal-ok');
    if (btn) btn.addEventListener('click', onOk);
  }
}

function hideModal() {
  $('modal-overlay').classList.add('hidden');
  $('modal-box')?.classList.remove('modal-wide');
  // If a live update arrived while the modal was open, apply it now
  if (typeof _pendingLiveReload !== 'undefined' && _pendingLiveReload) {
    _pendingLiveReload = false;
    // Give the in-flight save a moment to hit the DB first
    setTimeout(() => { try { _liveReloadState(); } catch {} }, 800);
  }
}

function teamLogoUrl(code) {
  if (!code) return '';
  const apiCode = NHL_API_CODE_MAP[code] || code;
  return `https://assets.nhle.com/logos/nhl/svg/${apiCode}_light.svg`;
}

function teamDisplayName(code) {
  const team = NHL_TEAMS.find(t => t.code === code);
  return team ? team.name : (code || '—');
}

function hexToRgbTriplet(hex) {
  const match = String(hex || '').trim().match(/^#?([a-f\d]{6})$/i);
  if (!match) return '200, 168, 78';
  const int = parseInt(match[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `${r}, ${g}, ${b}`;
}

function teamBadge(code) {
  const logo = teamLogoUrl(code);
  return `<span class="team-badge">${logo ? `<img src="${logo}" class="team-badge-logo" loading="lazy" onerror="this.style.display='none'">` : ''}${code || '—'}</span>`;
}

function teamLogoLg(code, size = 48) {
  const url = teamLogoUrl(code);
  if (!url) return '';
  return `<img src="${url}" class="team-logo-lg" width="${size}" height="${size}" loading="lazy" onerror="this.style.display='none'">`;
}

function ovrBadge(ovr) {
  if (!ovr) return '';
  const cls = ovr >= 90 ? 'ovr-gold' : ovr >= 80 ? 'ovr-blue' : ovr >= 70 ? 'ovr-green' : 'ovr-grey';
  return `<span class="ovr-badge ${cls}">${ovr}</span>`;
}

function pltBadge(plt) {
  if (!plt) return '';
  return `<span class="plt-badge plt-${plt}">${plt}</span>`;
}

// Normalize name for matching: strip accents, apostrophes, hyphens
function normName(str) {
  return str.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip diacritics (é→e, ö→o, etc.)
    .replace(/['\u2019`-]/g, '')       // strip apostrophes & hyphens (O'Connor→OConnor)
    .toUpperCase().trim();
}

// Match "M. BOLDY" or "M BOLDY" style abbreviated names to full player names
function matchPlayerByAbbrev(abbrev) {
  // Strip trailing disambiguation number: "ZUB 1" → "ZUB", "TANEV 1" → "TANEV"
  let clean = abbrev.trim().replace(/\s+\d+$/, '');
  let upper = normName(clean);

  // Strip trailing single uppercase letter suffix (e.g. "ROMANOV L" → "ROMANOV", "MANSON N" → "MANSON")
  upper = upper.replace(/ [A-Z]$/, '');

  const dotIdx = upper.indexOf('. ');
  let firstInitial, lastName;

  if (dotIdx > 0) {
    // Standard "A. LASTNAME" or "A. MULTI WORD" format
    firstInitial = upper[dotIdx - 1];
    lastName = upper.slice(dotIdx + 2).trim();
  } else {
    const spaceIdx = upper.indexOf(' ');
    if (spaceIdx === 1) {
      // "A LASTNAME" format — first char is initial
      firstInitial = upper[0];
      lastName = upper.slice(2).trim();
    } else if (spaceIdx === -1 && upper.length > 1) {
      // No space at all: treat first char as initial, rest as lastName (e.g. "TMYERS" → T + MYERS)
      firstInitial = upper[0];
      lastName = upper.slice(1);
    } else {
      firstInitial = null;
      lastName = upper;
    }
  }

  // Strip any remaining trailing number from lastName
  lastName = lastName.replace(/\s+\d+$/, '').trim();

  // Primary match: compare against final token of player name
  const primary = state.players.find(p => {
    const norm = normName(p.name).split(' ');
    const pLast = norm[norm.length - 1];
    const pFirst = norm[0]?.[0] || '';
    if (pLast !== lastName) return false;
    if (firstInitial && pFirst !== firstInitial) return false;
    return true;
  });
  if (primary) return primary;

  // Multi-word last name fallback: "ERIKSSON EK" → match last N tokens (e.g. Joel Eriksson Ek)
  const parts = lastName.split(' ');
  if (parts.length > 1) {
    return state.players.find(p => {
      const norm = normName(p.name).split(' ');
      if (norm.length < parts.length) return false;
      const pLastN = norm.slice(norm.length - parts.length).join(' ');
      if (pLastN !== lastName) return false;
      const pFirst = norm[0]?.[0] || '';
      if (firstInitial && pFirst !== firstInitial) return false;
      return true;
    }) || null;
  }

  return null;
}

function managerName(id) {
  const m = state.managers.find(m => m.id === id);
  return m ? m.name : '—';
}

function teamOwnerName(code) {
  const mid  = state.teamOwners[code];
  const mid2 = state.teamCoOwners?.[code];
  const n1 = mid  ? managerName(mid)  : '';
  const n2 = mid2 ? managerName(mid2) : '';
  if (n1 && n2) return `${n1} / ${n2}`;
  return n1 || n2 || '—';
}

function teamSelectOptions(selected='') {
  return NHL_TEAMS.map(t =>
    `<option value="${t.code}" ${t.code===selected?'selected':''}>${t.code} – ${t.name}</option>`
  ).join('');
}

function playerSelectOptions(teamCode, selected='') {
  const roster = state.players.filter(p => p.teamCode === teamCode);
  const opts = ['<option value="">— Empty —</option>',
    ...roster.map(p => `<option value="${p.id}" ${p.id==selected?'selected':''}>${p.name}</option>`)
  ];
  return opts.join('');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric' }) + ' · ' + d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

// ================================================================
// 7.  NAVIGATE
// ================================================================
function navigate(section) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  $(`section-${section}`).classList.add('active');
  document.querySelector(`.nav-btn[data-section="${section}"]`)?.classList.add('active');
  currentSection = section;
  if (section !== 'settings') _settingsSection = null;
  renderSection(section);
}

function renderSection(section) {
  switch (section) {
    case 'dashboard': renderDashboard(); break;
    case 'teams':     renderTeams();     break;
    case 'players':   renderPlayers();   break;
    case 'scores':    renderScores();    zbWarmCache(); break;
    case 'draft':     renderDraft();     break;
    case 'schedule':  renderSchedule();  zbWarmCache(); break;
    case 'standings': renderStandings(); break;
    case 'stats':     renderStats();     break;
    case 'playoffs':  renderPlayoffs();  break;
    case 'trades':    renderTrades();    break;
    case 'rules':     renderRules();     break;
    case 'settings':  renderSettings();  break;
  }
}

// ================================================================
// 8.  DASHBOARD
// ================================================================
function formatBytes(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

function downloadSysData() {
  const f = state.sysDataFile;
  if (!f) return;
  const a = document.createElement('a');
  a.href = '/api/sysdata';
  a.download = f.name || 'SYS-DATA';
  a.click();
}

function renderPlayoffRace(standings) {
  const CUT = 16;
  if (standings.length < 4) return '<div class="empty-state"><span class="empty-icon">🏒</span>Season not started</div>';

  const byPts = (a, b) => b.pts - a.pts || b.rw - a.rw || (b.gf - b.ga) - (a.gf - a.ga);
  const all = [...standings].sort(byPts);

  const cutPts = all[Math.min(CUT - 1, all.length - 1)].pts;
  // Show ranks 10 through end (bubble window around the 16-team cutline)
  const slice = all.slice(9);
  let html = '';
  slice.forEach((t, i) => {
    const rank = 10 + i;
    const isIn = rank <= CUT;
    const diff = t.pts - cutPts;
    const diffLabel = rank === CUT
      ? '<span class="race-diff race-diff-cut">CUTLINE</span>'
      : `<span class="race-diff ${diff >= 0 ? 'race-diff-in' : 'race-diff-out'}">${diff > 0 ? '+' : ''}${diff}</span>`;
    if (rank === CUT + 1) html += `<div class="race-cutline">OUT</div>`;
    html += `
      <div class="race-row ${isIn ? 'race-in' : 'race-out'}">
        <span class="race-rank">${rank}</span>
        ${teamLogoLg(t.teamCode, 30)}
        <div class="race-info">
          <span class="race-code">${t.teamCode}</span>
          <span class="race-mgr">${teamOwnerName(t.teamCode)}</span>
        </div>
        <span class="race-pts">${t.pts}</span>
        ${diffLabel}
      </div>`;
  });

  return `<div class="race-conf-col">${html}</div>`;
}

function l5Record(teamCode, n = 5) {
  const played = state.games
    .filter(g => g.played && !g.playoff && (g.homeTeam === teamCode || g.awayTeam === teamCode))
    .sort((a, b) => (b.playedAt || b.date || '').localeCompare(a.playedAt || a.date || ''))
    .slice(0, n);
  let w = 0, l = 0, ot = 0;
  // Current streak: count consecutive same results from most recent game
  let streak = 0, streakType = '';
  const results = [];
  played.forEach((g, i) => {
    const isHome = g.homeTeam === teamCode;
    const gf = isHome ? +g.homeScore : +g.awayScore;
    const ga = isHome ? +g.awayScore : +g.homeScore;
    const result = gf > ga ? 'W' : (g.ot ? 'OTL' : 'L');
    results.push(result);
    if (gf > ga) w++;
    else if (g.ot) ot++;
    else l++;
    if (i === 0) { streak = 1; streakType = result; }
    else if (result === streakType) streak++;
  });
  return { w, l, ot, pts: w * 2 + ot, games: played.length, streak, streakType, results };
}

function calcPowerRankings() {
  const standings = calcStandings();
  const ranked = standings.map(t => {
    const l10 = l5Record(t.teamCode, 10);
    const formPct   = l10.games > 0 ? l10.pts / (l10.games * 2) : 0;
    const seasonPct = t.gp > 0 ? t.pts / (t.gp * 2) : 0;
    const score = (formPct * 0.6) + (seasonPct * 0.4);
    return { ...t, prScore: score, l10 };
  }).sort((a, b) => b.prScore - a.prScore || b.pts - a.pts);

  // Attach rank + diff vs stored last-week rank
  const lastWeek = state.powerRankingsLastWeek || {};
  ranked.forEach((t, i) => {
    t.prRank = i + 1;
    const prev = lastWeek[t.teamCode];
    t.prDiff = prev != null ? prev - (i + 1) : null; // positive = moved up
  });
  return ranked;
}

function showSetWeekModal(current, auto) {
  const maxWeek = Math.max(...state.games.map(g => g.week || 1), auto, 1);
  showModal('Set Current Week', `
    <p class="text-xs text-muted mb-12">Override the current week shown on the dashboard. Leave blank to auto-calculate.</p>
    <div style="margin-bottom:12px">
      <label style="display:block;font-size:.85rem;font-weight:600;margin-bottom:6px">Current Week (auto: <strong>WK ${auto}</strong>)</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input type="number" id="week-input" min="1" max="${maxWeek}" value="${current || ''}" placeholder="1–${maxWeek}" style="flex:1;padding:8px;border:1px solid var(--border);border-radius:4px">
        ${current !== null ? `<button class="btn btn-ghost btn-sm" id="clear-week-btn">Clear (auto)</button>` : ''}
      </div>
      <div class="text-xs text-muted mt-8">Valid range: 1–${maxWeek}</div>
    </div>
    <button id="modal-ok" class="btn btn-primary btn-block mt-16">Set Week</button>
  `, () => {
    const input = $('week-input').value.trim();
    if (input === '') {
      state.currentWeek = null;
      toast('Week set to auto-calculate', 'success');
    } else {
      const w = parseInt(input);
      if (w >= 1 && w <= maxWeek) {
        state.currentWeek = w;
        toast(`Week manually set to ${w}`, 'success');
      } else {
        toast(`Invalid week (must be 1–${maxWeek})`, 'error');
        return;
      }
    }
    saveState();
    hideModal();
    renderDashboard();
  });
  $('clear-week-btn')?.addEventListener('click', () => {
    state.currentWeek = null;
    $('week-input').value = '';
    toast('Week set to auto-calculate', 'success');
    saveState();
    renderDashboard();
  });
}

async function checkPendingTrades() {
  if (!isAdmin) return;
  try {
    const r = await _apiFetch('/api/pending?status=pending', { 
      headers: { 'Authorization': `Bearer ${_adminToken}` } 
    });
    const data = await r.json();
    const count = data.length;
    
    // Update settings menu badge
    const settingsBadge = document.querySelector('[data-sect="pending"] .settings-badge');
    if (settingsBadge) {
      if (count > 0) {
        settingsBadge.textContent = count;
        settingsBadge.style.display = 'inline-block';
      } else {
        settingsBadge.style.display = 'none';
      }
    }
    
    // Update nav button badge
    const navBtn = document.querySelector('[data-nav="settings"]');
    if (navBtn && count > 0) {
      let badge = navBtn.querySelector('.nav-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        badge.style.cssText = 'position:absolute;top:4px;right:4px;background:#e74c3c;color:#fff;padding:2px 6px;border-radius:10px;font-size:10px;font-weight:600;min-width:18px;text-align:center';
        navBtn.style.position = 'relative';
        navBtn.appendChild(badge);
      }
      badge.textContent = count;
    } else if (navBtn) {
      const badge = navBtn.querySelector('.nav-badge');
      if (badge) badge.remove();
    }
  } catch (e) {
    // Silently fail
  }
}

function renderDashboard() {
  const el_ = $('section-dashboard');
  checkPendingTrades();
  const sysData = normalizeSysDataFile(state.sysDataFile);
  const standings = calcStandings();
  const recentGames = state.games
    .filter(g => g.played && !g.playoff)
    .sort((a, b) => (b.postedAt || b.playedAt || b.date || '').localeCompare(a.postedAt || a.playedAt || a.date || ''))
    .slice(0, 6);
  const recentTrades = [...state.trades]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 5);

  const gamesPlayed = state.games.filter(g=>g.played && !g.playoff).length;
  const totalTeams  = Object.keys(state.teamOwners).length;
  // Current week = admin override, or auto-calculate as lowest week with unplayed games
  const autoWeek = (() => {
    const unplayedWeeks = [...new Set(state.games.filter(g => !g.played && !g.playoff).map(g => g.week))];
    return unplayedWeeks.length > 0 ? Math.min(...unplayedWeeks) : (gamesPlayed > 0 ? Math.max(...state.games.map(g => g.week || 1)) : 1);
  })();
  const currentWeek = state.currentWeek !== null ? state.currentWeek : autoWeek;
  const upcoming    = sortGames(state.games.filter(g=>!g.played && !g.playoff && g.week === currentWeek)).slice(0,8);

  const fmtTradeName = p => resolvePlayerName(p, '#');

  // Hottest / coldest — prioritize active streaks, then L10 record
  // Hottest: longest active win streak (W only, not OTL), then best L10 record
  // Coldest: longest active loss streak (L only), then worst L10 record
  let hotTeams = [], coldTeams = [];
  if (standings.length >= 4) {
    const withL10 = standings
      .map(t => ({ ...t, l10: l5Record(t.teamCode, 10) }))
      .filter(t => t.l10.games >= 5);
    if (withL10.length >= 2) {
      // Hottest: longest active win streak (only show THE hottest, not ties)
      const hotCandidates = withL10.filter(t => t.l10.streakType === 'W');
      if (hotCandidates.length > 0) {
        hotCandidates.sort((a, b) => {
          // First by win streak length (longer is hotter)
          if (b.l10.streak !== a.l10.streak) return b.l10.streak - a.l10.streak;
          // Then by L10 points
          if (b.l10.pts !== a.l10.pts) return b.l10.pts - a.l10.pts;
          // Then by L10 wins
          return b.l10.w - a.l10.w;
        });
        // Only show the single hottest team (no ties)
        hotTeams = [hotCandidates[0]];
      }
      // Coldest: longest active loss streak (only show THE coldest, not ties)
      const coldCandidates = withL10.filter(t => t.l10.streakType === 'L');
      if (coldCandidates.length > 0) {
        coldCandidates.sort((a, b) => {
          // First by loss streak length (longer is colder)
          if (b.l10.streak !== a.l10.streak) return b.l10.streak - a.l10.streak;
          // Then by L10 points (fewer is colder)
          if (a.l10.pts !== b.l10.pts) return a.l10.pts - b.l10.pts;
          // Then by L10 wins (fewer is colder)
          return a.l10.w - b.l10.w;
        });
        // Only show the single coldest team (no ties)
        coldTeams = [coldCandidates[0]];
      }
    }
  }

  // Bubble gap — top 16 cutline
  const byPts = (a,b) => b.pts - a.pts || b.rw - a.rw || (b.gf-b.ga)-(a.gf-a.ga);
  const allSorted = [...standings].sort(byPts);
  const bubble16 = (() => {
    if (allSorted.length < 17) return null;
    if (!allSorted.some(t => t.gp > 0)) return null;
    return { gap: allSorted[15].pts - allSorted[16].pts, in: allSorted[15], out: allSorted[16] };
  })();

  const _fdot = r => {
    const cls = r==='W'?'form-w':r==='OTL'?'form-otl':'form-l';
    return `<span class="form-dot ${cls}" style="font-size:.6rem;width:16px;height:16px">${r==='OTL'?'O':r}</span>`;
  };
  const _strkBadge = (streakType, streak) => {
    if (!streakType) return '';
    const cls = streakType==='W'?'streak-w':streakType==='OTL'?'streak-otl':'streak-l';
    return `<span class="streak-badge ${cls}" style="font-size:.68rem">${streakType}${streak}</span>`;
  };
  const trendCard = (teams, type) => {
    const label = type === 'hot' ? '🔥 Hottest' : '❄️ Coldest';
    if (!teams.length) return `<div class="stat-card stat-card-trend"><div class="sct-label">${label}</div><div class="sct-empty">—</div></div>`;
    const accent = type === 'hot' ? 'var(--stat-hot)' : 'var(--stat-cold)';
    const teamRows = teams.map(team => {
      const r = team.l10;
      const rec = `${r.w}-${r.l}${r.ot ? `-${r.ot}` : ''}`;
      // results: most-recent first → reverse to show oldest→newest L→R
      const dots = (r.results || []).slice().reverse().map(_fdot).join('');
      return `
        <div class="sct-team-row">
          ${teamLogoLg(team.teamCode, 32)}
          <div class="sct-info">
            <span class="sct-code">${team.teamCode}</span>
            <span class="sct-mgr">${teamOwnerName(team.teamCode)}</span>
          </div>
          <div class="sct-trend-right">
            <span class="sct-record">${rec} ${_strkBadge(r.streakType, r.streak)}</span>
            <div class="sct-form-dots">${dots}</div>
          </div>
        </div>`;
    }).join('');
    const tiedBadge = teams.length > 1 ? `<span class="sct-tied-badge">TIED</span>` : '';
    return `
      <div class="stat-card stat-card-trend" style="--accent:${accent}">
        <div class="sct-label">${label} <span class="sct-l10-tag">L10</span>${tiedBadge}</div>
        ${teamRows}
      </div>`;
  };

  const bubbleCard = (b) => {
    const body = b
      ? (() => {
          const { gap, in: inTeam, out: outTeam } = b;
          const gapLabel = gap === 0 ? 'TIED' : gap + ' PT' + (gap !== 1 ? 'S' : '');
          const gapClass = gap === 0 ? 'gap-zero' : gap <= 2 ? 'gap-tight' : 'gap-safe';
          return `<div class="sct-bubble-conf">
               <span class="sct-bubble-gap ${gapClass}">${gapLabel}</span>
               <span class="text-xs text-muted" style="display:block;margin-top:2px">${inTeam.teamCode} (#16 in) vs ${outTeam.teamCode} (#17 out)</span>
             </div>`;
        })()
      : '<div class="sct-empty">—</div>';
    return `
      <div class="stat-card stat-card-bubble">
        <div class="sct-label">⚡ Bubble Gap</div>
        <div class="sct-bubble-body">${body}</div>
        <div class="sct-bubble-sub">pts separating #16 from #17</div>
      </div>`;
  };

  el_.innerHTML = `
    <!-- HERO BANNER -->
    <div class="dash-hero">
      <div class="dash-hero-content">
        <div class="dash-hero-eyebrow">NHL Legacy</div>
        <div class="dash-hero-title">${state.league?.name || 'Legacy League'}</div>
        <div class="dash-hero-meta">
          ${totalTeams} Teams &nbsp;·&nbsp;
          ${currentWeek > 0 ? 'Season · Week ' + currentWeek : 'Season not started'}
          ${state.playoffs ? '&nbsp;·&nbsp; <span style="color:var(--gold);font-weight:700">⬡ Playoffs Active</span>' : ''}
        </div>
      </div>
      <div class="dash-hero-gfx"><img src="assets/zamboni.png" alt="" class="hero-zamboni"></div>
    </div>

    <!-- STAT CARDS -->
    <div class="dash-grid">
      ${trendCard(hotTeams, 'hot')}
      ${trendCard(coldTeams, 'cold')}
      ${bubbleCard(bubble16)}
      <div class="stat-card stat-card-week">
        <div class="sct-label">📅 Season${isAdmin ? ' <button class="btn btn-ghost btn-xs" id="set-week-btn" style="font-size:.65rem">⚙️</button>' : ''}</div>
        <div class="sct-week-num">${currentWeek > 0 ? 'WK ' + currentWeek : '—'}${state.currentWeek !== null ? ' 📌' : ''}</div>
        <div class="sct-week-sub">${gamesPlayed} games played${state.currentWeek !== null ? ' (manual)' : ''}</div>
      </div>
    </div>

    <!-- SYS-DATA DOWNLOAD (if file uploaded) -->
    ${sysData ? `
    <div class="sysdata-bar">
      <div class="sysdata-bar-left">
        <span class="sysdata-bar-icon">💾</span>
        <div>
          <div class="sysdata-bar-title">SYS-DATA${sysData.week ? ` — Week ${sysData.week}` : ' Available'}</div>
          <div class="sysdata-bar-meta">${sysData.name} · ${formatBytes(sysData.size)} · Updated ${fmtDate(sysData.uploadedAt)}</div>
        </div>
      </div>
      <button class="btn btn-accent" id="dl-sysdata-btn">⬇ Download</button>
    </div>` : ''}

    <div class="portal-dashboard-slot">
      ${portalCardHTML()}
    </div>


    <!-- PANELS -->
    <div class="dash-panels">

      <!-- Recent Results — scoreboard style -->
      <div class="panel conf-standings">
        <div class="conf-header"><span class="conf-title">Recent Results</span></div>
        <div class="panel-body" style="padding:0">
          ${recentGames.length ? recentGames.map(g => {
            const homeWin = +g.homeScore > +g.awayScore;
            return `
            <div class="sb-game">
              <div class="sb-team ${homeWin ? 'sb-winner' : 'sb-loser'}">
                <div class="sb-logo">${teamLogoLg(g.homeTeam, 52)}</div>
                <div class="sb-info">
                  <div class="sb-code">${g.homeTeam}</div>
                  <div class="sb-mgr">${teamOwnerName(g.homeTeam)}</div>
                </div>
                <div class="sb-score ${homeWin ? 'sb-score-win' : ''}">${g.homeScore}</div>
              </div>
              <div class="sb-sep">
                <span class="sb-ot">${g.ot ? 'OT' : ''}</span>
                <span class="sb-vs">Final</span>
                ${g.isMakeup ? `<span class="badge-mu">MU</span>` : ''}
                ${g.postedAt ? `<span class="sb-posted">${fmtDateTime(g.postedAt)}</span>` : (g.week ? `<span class="sb-posted">Wk ${g.week}</span>` : '')}
              </div>
              <div class="sb-team ${!homeWin ? 'sb-winner' : 'sb-loser'}">
                <div class="sb-score ${!homeWin ? 'sb-score-win' : ''}">${g.awayScore}</div>
                <div class="sb-info" style="text-align:right">
                  <div class="sb-code">${g.awayTeam}</div>
                  <div class="sb-mgr">${teamOwnerName(g.awayTeam)}</div>
                </div>
                <div class="sb-logo">${teamLogoLg(g.awayTeam, 52)}</div>
              </div>
            </div>`;
          }).join('') : '<div class="empty-state"><span class="empty-icon">🏒</span>No games played yet</div>'}
        </div>
      </div>

      <!-- Upcoming Games -->
      <div class="panel conf-standings">
        <div class="conf-header">
          <span class="conf-title">📅 Week ${currentWeek}</span>
          ${(() => {
            const wkGames  = state.games.filter(g => !g.playoff && g.week === currentWeek);
            const wkPlayed = wkGames.filter(g => g.played).length;
            const wkTotal  = wkGames.length;
            if (!wkTotal) return '';
            const pct = Math.round((wkPlayed / wkTotal) * 100);
            const allDone = wkPlayed === wkTotal;
            return `
              <div class="wk-progress-wrap">
                <span class="wk-progress-label ${allDone ? 'wk-done' : ''}">${wkPlayed}/${wkTotal}${allDone ? ' ✓' : ''}</span>
                <div class="wk-progress-bar">
                  <div class="wk-progress-fill ${allDone ? 'wk-fill-done' : ''}" style="width:${pct}%"></div>
                </div>
              </div>`;
          })()}
        </div>
        <div class="panel-body" style="padding:0">
          ${upcoming.length ? upcoming.map(g => `
            <div class="sb-game sb-upcoming">
              <div class="sb-team">
                <div class="sb-logo">${teamLogoLg(g.homeTeam, 46)}</div>
                <div class="sb-info">
                  <div class="sb-code">${g.homeTeam}</div>
                  <div class="sb-mgr">${teamOwnerName(g.homeTeam)}</div>
                </div>
              </div>
              <div class="sb-sep">
                <span class="sb-vs">VS</span>
                <span class="sb-ot" style="color:var(--text-dim)">${gameLabel(g)}</span>
              </div>
              <div class="sb-team" style="justify-content:flex-end">
                <div class="sb-info" style="text-align:right">
                  <div class="sb-code">${g.awayTeam}</div>
                  <div class="sb-mgr">${teamOwnerName(g.awayTeam)}</div>
                </div>
                <div class="sb-logo">${teamLogoLg(g.awayTeam, 46)}</div>
              </div>
            </div>`).join('') :
          '<div class="empty-state"><span class="empty-icon">📅</span>No upcoming games scheduled</div>'}
        </div>
      </div>

      <!-- Power Rankings -->
      <div class="panel conf-standings" id="dash-power-rankings">
        <div class="conf-header">
          <span class="conf-title">⚡ Power Rankings</span>
          <span class="conf-sub">60% L10 form · 40% season record</span>
        </div>
        <div class="panel-body" style="padding:0">
          ${(() => {
            const pr = calcPowerRankings();
            if (!pr.length || !pr.some(t => t.gp > 0)) return '<div class="empty-state"><span class="empty-icon">⚡</span>Season not started</div>';
            return pr.slice(0, 10).map((t, i) => {
              const diff = t.prDiff;
              const arrow = diff == null ? '<span class="pr-diff pr-diff-new">NEW</span>'
                : diff > 0  ? `<span class="pr-diff pr-diff-up">▲${diff}</span>`
                : diff < 0  ? `<span class="pr-diff pr-diff-dn">▼${Math.abs(diff)}</span>`
                : '<span class="pr-diff pr-diff-eq">—</span>';
              const r = t.l10;
              const l10str = r.games > 0 ? `${r.w}-${r.l}${r.ot ? `-${r.ot}` : ''}` : '—';
              const dots = r.games > 0
                ? (r.results||[]).slice().reverse().map(res => {
                    const cls = res==='W'?'form-w':res==='OTL'?'form-otl':'form-l';
                    return `<span class="form-dot ${cls}" style="font-size:.5rem;width:13px;height:13px">${res==='OTL'?'O':res}</span>`;
                  }).join('')
                : '';
              return `
              <div class="pr-row${i === 0 ? ' pr-row-top' : ''}">
                <span class="pr-rank">${t.prRank}</span>
                ${arrow}
                <span class="pr-logo">${teamLogoLg(t.teamCode, 32)}</span>
                <span class="pr-info">
                  <span class="pr-code">${t.teamCode}</span>
                  <span class="pr-mgr">${teamOwnerName(t.teamCode)}</span>
                </span>
                <span class="pr-stats">
                  <span class="pr-pts">${t.pts} pts</span>
                  <span class="pr-l10">${l10str}</span>
                  ${dots ? `<span class="pr-dots">${dots}</span>` : ''}
                </span>
              </div>`;
            }).join('');
          })()}
        </div>
      </div>

      <!-- Trade Wire -->
      <div class="panel conf-standings" id="dash-trade-wire">
        <div class="conf-header">
          <span class="conf-title">🔄 Trade Wire</span>
          <span class="conf-sub">Latest transactions</span>
        </div>
        <div class="panel-body" style="padding:0">
          ${(() => {
            if (!recentTrades.length) return '<div class="empty-state"><span class="empty-icon">🔄</span>No trades yet</div>';
            const now = new Date();
            return recentTrades.map(tr => {
              const tradeDate = new Date(tr.date || '');
              const hoursAgo = isNaN(tradeDate) ? null : (now - tradeDate) / 3600000;
              const isHot = hoursAgo != null && hoursAgo < 24;
              const isRecent = hoursAgo != null && hoursAgo < 72;
              const dateStr = isNaN(tradeDate) ? (tr.date || '') : tradeDate.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
              const hotBadge = isHot ? '<span class="tw-hot">🔴 NEW</span>' : isRecent ? '<span class="tw-recent">NEW</span>' : '';

              const fmtAssets = (assets) => {
                if (!assets || !assets.length) return '<span class="tw-empty-assets">—</span>';
                const list = Array.isArray(assets) ? assets : assets.split(',').map(s => s.trim()).filter(Boolean);
                return list.map(name => {
                  const p = state.players.find(x => x.name === name || x.id === name);
                  return p ? `<span class="tw-player">${p.name}${p.ovr ? ` <span class="tw-ovr">${p.ovr}</span>` : ''}</span>` : `<span class="tw-player">${name}</span>`;
                }).join(' ');
              };

              return `
              <div class="tw-card">
                <div class="tw-header">
                  <div class="tw-teams">
                    ${teamLogoLg(tr.fromTeam, 28)}
                    <span class="tw-team-code">${tr.fromTeam}</span>
                    <span class="tw-arrow">⇌</span>
                    <span class="tw-team-code">${tr.toTeam}</span>
                    ${teamLogoLg(tr.toTeam, 28)}
                  </div>
                  <div class="tw-meta">${hotBadge}<span class="tw-date">${dateStr}</span></div>
                </div>
                <div class="tw-body">
                  <div class="tw-side"><span class="tw-dir">${tr.fromTeam} gets:</span> ${fmtAssets(tr.playersReceived)}</div>
                  <div class="tw-side"><span class="tw-dir">${tr.toTeam} gets:</span> ${fmtAssets(tr.playersSent)}</div>
                </div>
                ${tr.notes ? `<div class="tw-notes">${tr.notes}</div>` : ''}
              </div>`;
            }).join('');
          })()}
        </div>
      </div>

    </div>
  `;
  bindPortalDashboardActions();
  $('dl-sysdata-btn')?.addEventListener('click', downloadSysData);
  $('set-week-btn')?.addEventListener('click', () => showSetWeekModal(currentWeek, autoWeek));
}
// ================================================================
// 9.  TEAMS PAGE
// ================================================================
let _teamsSort = { by: 'ovr', dir: 'desc' };

function renderTeams() {
  const el_ = $('section-teams');

  const activeCodes = [...new Set([
    ...Object.keys(state.teamOwners),
    ...state.players.map(p => p.teamCode).filter(Boolean),
  ])].sort();

  const logoStrip = NHL_TEAMS.filter(t => activeCodes.includes(t.code)).map(t => `
    <a class="logo-strip-item" href="#team-card-${t.code}" title="${t.name}">
      ${teamLogoLg(t.code, 40)}
    </a>`).join('');

  const sortDir = _teamsSort.dir === 'asc' ? '↑' : '↓';
  const pill = (col, label) =>
    `<button class="sort-pill${_teamsSort.by===col?' active':''}" data-sort="${col}">${label}${_teamsSort.by===col?' '+sortDir:''}</button>`;

  el_.innerHTML = `
    <div class="page-header" style="flex-wrap:wrap;gap:10px">
      <h2>Teams</h2>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="text-xs text-muted">Sort players:</span>
        ${pill('ovr','OVR')} ${pill('name','Name')} ${pill('pos','Pos')} ${pill('plt','PLT')}
        <input type="text" id="teams-search" placeholder="Search players…" style="width:160px;margin-left:8px">
      </div>
    </div>

    ${activeCodes.length ? `<div class="logo-strip">${logoStrip}</div>` : ''}

    <div id="teams-list" class="teams-grid">
      ${renderTeamsList('')}
    </div>
  `;

  $('teams-search').addEventListener('input', e => {
    $('teams-list').innerHTML = renderTeamsList(e.target.value.toLowerCase());
    attachTeamHandlers();
  });

  attachTeamHandlers();

  function attachTeamHandlers() {
    document.querySelectorAll('.edit-roster-btn').forEach(btn => {
      btn.addEventListener('click', () => showEditRoster(btn.dataset.code));
    });
    document.querySelectorAll('.sort-pill[data-sort]').forEach(btn => {
      btn.addEventListener('click', () => {
        const col = btn.dataset.sort;
        if (_teamsSort.by === col) {
          _teamsSort.dir = _teamsSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          _teamsSort.by  = col;
          _teamsSort.dir = (col === 'name' || col === 'pos' || col === 'plt') ? 'asc' : 'desc';
        }
        renderTeams();
      });
    });
  }
}

function showEditRoster(teamCode) {
  const team = NHL_TEAMS.find(t => t.code === teamCode);
  const players = state.players.filter(p => p.teamCode === teamCode);
  const managedTeams = NHL_TEAMS.filter(t => state.teamOwners[t.code]);

  showModal(`Edit Roster — ${team ? team.name : teamCode}`, `
    <p class="text-xs text-muted mb-12">Move players between teams. This does <strong>not</strong> create a trade record.</p>
    <div class="table-wrap" style="max-height:420px;overflow-y:auto">
      <table>
        <thead><tr><th>Player</th><th>OVR</th><th>Move to…</th></tr></thead>
        <tbody>
          ${players.length ? players.map(p => `
            <tr>
              <td class="font-bold">${p.name} ${p.position ? `<span class="pos-badge pos-${p.position}">${p.position}</span>` : ''}</td>
              <td>${ovrBadge(p.ovr)}</td>
              <td>
                <select class="roster-move-sel" data-pid="${p.id}" style="font-size:.78rem">
                  <option value="${teamCode}">— Keep here —</option>
                  ${managedTeams.filter(t => t.code !== teamCode).map(t =>
                    `<option value="${t.code}">${t.code} – ${teamOwnerName(t.code)}</option>`
                  ).join('')}
                  <option value="">Unassigned (FA)</option>
                </select>
              </td>
            </tr>`).join('') : '<tr><td colspan="3" class="text-dim">No players on this team</td></tr>'}
        </tbody>
      </table>
    </div>
    <button id="modal-ok" class="btn btn-primary btn-block mt-16">Save Changes</button>
  `, () => {
    let moved = 0;
    document.querySelectorAll('.roster-move-sel').forEach(sel => {
      const pid = sel.dataset.pid;
      const dest = sel.value;
      const p = state.players.find(x => String(x.id) === String(pid));
      if (p && dest !== teamCode) { p.teamCode = dest || ''; moved++; }
    });
    saveState();
    hideModal();
    if (moved) toast(`${moved} player${moved>1?'s':''} moved — not a trade record`, 'success');
    renderTeams();
  });
}

function renderTeamsList(q) {
  const activeCodes = [...new Set([
    ...Object.keys(state.teamOwners),
    ...state.players.map(p => p.teamCode).filter(Boolean),
  ])].sort();

  if (!activeCodes.length) {
    return `<div class="empty-state" style="grid-column:1/-1">${state.players.length ? 'No teams assigned yet' : 'No roster loaded. Fetch NHL rosters in Settings.'}</div>`;
  }

  const sortPlayers = arr => [...arr].sort((a, b) => {
    const dir = _teamsSort.dir === 'asc' ? 1 : -1;
    switch (_teamsSort.by) {
      case 'name': return dir * a.name.localeCompare(b.name);
      case 'pos':  return dir * (a.position||'ZZZ').localeCompare(b.position||'ZZZ');
      case 'plt':  return dir * (a.plt||'ZZZ').localeCompare(b.plt||'ZZZ');
      default:     return dir * ((a.ovr||0) - (b.ovr||0));
    }
  });

  const playerRow = p => `
    <div class="tc-player-row">
      ${p.headshot
        ? `<img src="${p.headshot}" class="tc-headshot" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="tc-headshot-ph"></div>`}
      <span class="tc-name">${p.name}</span>
      <span class="tc-badges">
        ${p.position ? `<span class="pos-badge pos-${p.position}">${p.position}</span>` : ''}
        ${ovrBadge(p.ovr)}
        ${pltBadge(p.plt)}
      </span>
      <span class="tc-num text-dim">${p.number ? '#'+p.number : ''}</span>
    </div>`;

  const posSection = (label, players) => players.length ? `
    <div class="tc-pos-label">${label}</div>
    ${players.map(playerRow).join('')}` : '';

  return NHL_TEAMS.filter(t => activeCodes.includes(t.code)).map(t => {
    let allPlayers = state.players.filter(p => p.teamCode === t.code);
    if (q) allPlayers = allPlayers.filter(p => p.name.toLowerCase().includes(q));
    const sorted = sortPlayers(allPlayers);

    const forwards = sorted.filter(p => posGroup(p.position || '') === 'F');
    const defense  = sorted.filter(p => posGroup(p.position || '') === 'D');
    const goalies  = sorted.filter(p => posGroup(p.position || '') === 'G');
    const mgr = teamOwnerName(t.code);

    return `
      <div class="tc-card" id="team-card-${t.code}">
        <div class="tc-header">
          <div class="tc-logo">${teamLogoLg(t.code, 52)}</div>
          <div class="tc-title">
            <div class="tc-team-name">${t.name}</div>
            ${mgr !== '—' ? `<div class="tc-mgr">${mgr}</div>` : ''}
          </div>
          ${isAdmin ? `<button class="btn btn-ghost edit-roster-btn" data-code="${t.code}" style="font-size:.75rem;margin-left:auto;padding:4px 8px">📝 Edit</button>` : ''}
        </div>
        <div class="tc-body">
          ${allPlayers.length
            ? posSection('Forwards', forwards) + posSection('Defense', defense) + posSection('Goalies', goalies)
            : `<div class="text-dim text-sm" style="padding:12px">${q ? 'No matches' : 'No players assigned'}</div>`}
        </div>
        <div class="tc-footer">
          <span>F <strong>${forwards.length}</strong></span>
          <span>D <strong>${defense.length}</strong></span>
          <span>G <strong>${goalies.length}</strong></span>
          <span style="margin-left:auto;color:var(--text-dim)">${allPlayers.length} players</span>
        </div>
      </div>`;
  }).join('') || `<div class="empty-state" style="grid-column:1/-1">No players match "${q}"</div>`;
}

function renderRosterTable(players, q, teamFilter) {
  let filtered = players;
  if (q) filtered = filtered.filter(p => p.name.toLowerCase().includes(q));
  if (teamFilter === '_none') filtered = filtered.filter(p => !p.teamCode);
  else if (teamFilter) filtered = filtered.filter(p => p.teamCode === teamFilter);

  if (!filtered.length) {
    return `<div class="empty-state">${players.length ? 'No players match filter' : 'No players loaded. Fetch NHL rosters in Settings.'}</div>`;
  }

  const rows = filtered.map(p => `
    <tr>
      <td class="font-bold">${p.name}</td>
      <td>${teamBadge(p.teamCode || 'FA')}</td>
      <td class="text-sm text-muted">${teamOwnerName(p.teamCode)}</td>
      ${isAdmin ? `<td><button class="btn btn-ghost btn-sm assign-player-btn" data-pid="${p.id}">Assign</button></td>` : '<td></td>'}
    </tr>`).join('');

  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Player</th><th>Team</th><th>Manager</th>
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Assign single player to team
document.addEventListener('click', e => {
  if (!e.target.classList.contains('assign-player-btn')) return;
  e.stopPropagation();
  e.preventDefault();
  console.log('[Assign] Button clicked, pid=', e.target.dataset.pid);
  if (!isAdmin) { toast('Admin access required', 'error'); return; }
  const pid = e.target.dataset.pid;
  const p = state.players.find(x => String(x.id) === String(pid));
  if (!p) { console.warn('[Assign] Player not found for pid', pid, 'sample ids:', state.players.slice(0,3).map(x=>x.id)); return; }
  showModal('Assign Player Team', `
    <div class="form-row">
      <label>${p.name}</label>
      <select id="assign-team-select">
        <option value="">— Free Agent —</option>
        ${NHL_TEAMS.filter(t=>t.code!=='UTI').map(t=>`<option value="${t.code}" ${t.code===p.teamCode?'selected':''}>${t.code} – ${t.name}</option>`).join('')}
      </select>
    </div>
    <button id="modal-ok" class="btn btn-primary btn-block mt-12">Save</button>
  `, () => {
    p.teamCode = $('assign-team-select').value;
    saveState();
    hideModal();
    renderPlayers();
    toast('Assignment saved', 'success');
  });
});

// Edit player OVR / PLT
document.addEventListener('click', e => {
  if (!e.target.classList.contains('edit-rating-btn')) return;
  e.stopPropagation();
  e.preventDefault();
  console.log('[Edit] Button clicked, pid=', e.target.dataset.pid);
  if (!isAdmin) { toast('Admin access required', 'error'); return; }
  const pid = e.target.dataset.pid;
  const p = state.players.find(x => String(x.id) === String(pid));
  if (!p) { console.warn('[Edit] Player not found for pid', pid); return; }
  const PLT_CODES = ['TWF','PWF','SNP','ENF','GRN','HKY','SNW','PLY','TWD','OFD','DFD','PWD','EPC','GKP','HYB','BUT'];
  showModal(`Edit Rating — ${p.name}`, `
    <div class="form-row">
      <label>OVR (60–99)</label>
      <input type="number" id="er-ovr" value="${p.ovr || ''}" min="60" max="99" style="width:80px;font-size:1.2rem;font-weight:700;text-align:center">
    </div>
    <div class="form-row mt-8">
      <label>PLT (play type)</label>
      <select id="er-plt">
        <option value="">— None —</option>
        ${PLT_CODES.map(c => `<option value="${c}" ${p.plt===c?'selected':''}>${c}</option>`).join('')}
      </select>
      <input type="text" id="er-plt-custom" placeholder="or type custom code" value="${p.plt && !PLT_CODES.includes(p.plt) ? p.plt : ''}" style="margin-top:6px;width:140px;text-transform:uppercase">
    </div>
    <button id="modal-ok" class="btn btn-primary btn-block mt-12">Save</button>
  `, () => {
    const ovr = parseInt($('er-ovr').value) || null;
    const pltCustom = $('er-plt-custom')?.value.trim().toUpperCase();
    const plt = pltCustom || $('er-plt').value || null;
    p.ovr = ovr;
    p.plt = plt;
    saveState();
    hideModal();
    renderPlayers();
    toast('Rating updated', 'success');
  });
});

// ================================================================
// 10. PLAYERS PAGE
// ================================================================
let _plSort = { by: 'ovr', dir: 'desc' };

function renderPlayers() {
  const el_ = $('section-players');

  el_.innerHTML = `
    <div class="page-header"><h2>Players</h2></div>

    <div class="flex gap-10 mb-12" style="flex-wrap:wrap">
      <input type="text" id="pl-search" placeholder="Search by name..." style="flex:1;min-width:200px">
      <select id="pl-team-filter" style="min-width:180px">
        <option value="">All Teams</option>
        ${NHL_TEAMS.filter(t=>t.code!=='UTI').map(t => `<option value="${t.code}">${t.code} – ${t.name}</option>`).join('')}
        <option value="_none">Unassigned</option>
      </select>
      <select id="pl-pos-filter" style="min-width:120px">
        <option value="">All Positions</option>
        <option value="C">C</option>
        <option value="LW">LW</option>
        <option value="RW">RW</option>
        <option value="D">D</option>
        <option value="G">G</option>
      </select>
      <select id="pl-attr-filter" style="min-width:150px">
        <option value="">Show All Players</option>
        <option value="has-attrs">★ With Attributes</option>
        <option value="no-attrs">No Attributes</option>
      </select>
    </div>

    <div id="players-table-wrap"></div>
  `;

  $('pl-search').addEventListener('input', refreshPlayersTable);
  $('pl-team-filter').addEventListener('change', refreshPlayersTable);
  $('pl-pos-filter').addEventListener('change', refreshPlayersTable);
  $('pl-attr-filter').addEventListener('change', refreshPlayersTable);
  refreshPlayersTable();
}

function refreshPlayersTable() {
  const q  = $('pl-search')?.value.toLowerCase() || '';
  const tf = $('pl-team-filter')?.value || '';
  const pf = $('pl-pos-filter')?.value || '';
  const af = $('pl-attr-filter')?.value || '';
  const wrap = $('players-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = renderPlayersTable(q, tf, pf, af, _plSort.by, _plSort.dir);

  // Column header click-to-sort
  wrap.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (_plSort.by === col) {
        _plSort.dir = _plSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        _plSort.by = col;
        _plSort.dir = 'desc';
      }
      renderPlayers();
    });
  });
  
  // Player row click to show card
  wrap.querySelectorAll('.player-row-clickable').forEach(row => {
    row.addEventListener('click', (e) => {
      // Don't open card if clicking buttons or action cell
      if (e.target.tagName === 'BUTTON') return;
      if (e.target.closest('.action-cell')) return;
      if (e.target.classList.contains('assign-player-btn')) return;
      if (e.target.classList.contains('edit-rating-btn')) return;
      
      const playerId = row.dataset.playerId;
      const player = state.players.find(p => String(p.id) === String(playerId));
      if (player) {
        showPlayerCard(player);
      }
    });
  });
}

function showPlayerCard(player) {
  const attrs = player.attributes || {};
  const hasAttrs = !!player.attributes;
  const seasonStats = player.seasonStats || {};
  
  // Attribute categories
  const skating = hasAttrs ? [
    { label: 'Speed', value: attrs.speed },
    { label: 'Acceleration', value: attrs.acceleration },
    { label: 'Agility', value: attrs.agility },
    { label: 'Balance', value: attrs.balance },
  ] : [];
  
  const shooting = hasAttrs ? [
    { label: 'Wrist Shot Power', value: attrs.wrist_shot_power },
    { label: 'Wrist Shot Accuracy', value: attrs.wrist_shot_accuracy },
    { label: 'Slap Shot Power', value: attrs.slap_shot_power },
    { label: 'Slap Shot Accuracy', value: attrs.slap_shot_accuracy },
  ] : [];
  
  const skills = hasAttrs ? [
    { label: 'Passing', value: attrs.passing },
    { label: 'Puck Control', value: attrs.puck_control },
    { label: 'Deking', value: attrs.deking },
    { label: 'Hand-Eye', value: attrs.hand_eye },
  ] : [];
  
  const defense = hasAttrs ? [
    { label: 'Defensive Awareness', value: attrs.defensive_awareness },
    { label: 'Stick Checking', value: attrs.stick_checking },
    { label: 'Shot Blocking', value: attrs.shot_blocking },
  ] : [];
  
  const physical = hasAttrs ? [
    { label: 'Strength', value: attrs.strength },
    { label: 'Body Checking', value: attrs.body_checking },
    { label: 'Aggression', value: attrs.aggression },
    { label: 'Durability', value: attrs.durability },
  ] : [];
  
  const mental = hasAttrs ? [
    { label: 'Offensive Awareness', value: attrs.offensive_awareness },
    { label: 'Discipline', value: attrs.discipline },
    { label: 'Poise', value: attrs.poise },
  ] : [];
  
  const attrSection = (title, items) => {
    if (!items.length) return '';
    return `
      <div class="player-card-attr-section">
        <h4>${title}</h4>
        ${items.map(item => `
          <div class="player-card-attr-row">
            <span>${item.label}</span>
            <span class="player-card-attr-value">${item.value}</span>
          </div>
        `).join('')}
      </div>
    `;
  };
  
  showModal(`${player.name}`, `
    <div class="player-card">
      <div class="player-card-header">
        ${player.headshot ? `<img src="${player.headshot}" class="player-card-headshot" onerror="this.style.display='none'">` : ''}
        <div class="player-card-info">
          <div class="player-card-number">${player.number ? `#${player.number}` : ''}</div>
          <div class="player-card-position">${player.position || '—'}</div>
          <div class="player-card-team">${player.teamCode ? teamBadge(player.teamCode) : '<span class="text-dim">Free Agent</span>'}</div>
          <div class="player-card-manager text-sm text-muted">${teamOwnerName(player.teamCode)}</div>
        </div>
        <div class="player-card-ratings">
          <div class="player-card-ovr">
            <div class="text-xs text-muted">OVERALL</div>
            <div class="text-2xl font-bold">${player.ovr || player.overall || '—'}</div>
            ${player.sysdataOverall && player.sysdataOverall !== player.ovr ? `<div class="text-xs text-dim">(SYS-DATA: ${player.sysdataOverall})</div>` : ''}
          </div>
          ${player.plt ? `
            <div class="player-card-plt">
              <div class="text-xs text-muted">POTENTIAL</div>
              <div class="text-xl font-bold">${player.plt}</div>
            </div>
          ` : ''}
        </div>
      </div>
      
      ${hasAttrs ? `
        <div class="player-card-attributes">
          <div class="player-card-section-title">
            <h3>Attributes</h3>
            <span class="text-xs text-muted">From SYS-DATA</span>
          </div>
          <div class="player-card-attr-grid">
            ${attrSection('Skating', skating)}
            ${attrSection('Shooting', shooting)}
            ${attrSection('Skills', skills)}
            ${attrSection('Defense', defense)}
            ${attrSection('Physical', physical)}
            ${attrSection('Mental', mental)}
          </div>
        </div>
      ` : `
        <div class="player-card-no-attrs">
          <p class="text-dim">No attribute data available</p>
          <p class="text-xs text-muted mt-4">Upload SYS-DATA file to see player attributes</p>
        </div>
      `}
      
      ${seasonStats.gamesPlayed ? `
        <div class="player-card-season-stats">
          <h3>Season Stats</h3>
          <div class="player-card-stats-grid">
            <div class="stat-item">
              <div class="stat-label">GP</div>
              <div class="stat-value">${seasonStats.gamesPlayed}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">G</div>
              <div class="stat-value">${seasonStats.goals || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">A</div>
              <div class="stat-value">${seasonStats.assists || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">PTS</div>
              <div class="stat-value font-bold">${seasonStats.points || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">+/-</div>
              <div class="stat-value">${seasonStats.plusMinus > 0 ? '+' : ''}${seasonStats.plusMinus || 0}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">PIM</div>
              <div class="stat-value">${seasonStats.pim || 0}</div>
            </div>
          </div>
        </div>
      ` : ''}
    </div>
  `);
}

function renderPlayersTable(q, teamFilter, posFilter, attrFilter, sortBy, sortDir = 'desc') {
  if (!state.players.length) {
    return `<div class="empty-state">No players loaded.</div>`;
  }

  let list = [...state.players];
  if (q) list = list.filter(p => p.name.toLowerCase().includes(q));
  if (teamFilter === '_none') list = list.filter(p => !p.teamCode);
  else if (teamFilter) list = list.filter(p => p.teamCode === teamFilter);
  if (posFilter) list = list.filter(p => p.position === posFilter);
  if (attrFilter === 'has-attrs') list = list.filter(p => p.attributes);
  else if (attrFilter === 'no-attrs') list = list.filter(p => !p.attributes);

  const asc = sortDir === 'asc';
  if (sortBy === 'name') list.sort((a, b) => asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
  else if (sortBy === 'pos') list.sort((a, b) => asc ? (a.position||'Z').localeCompare(b.position||'Z') : (b.position||'Z').localeCompare(a.position||'Z'));
  else if (sortBy === 'team') list.sort((a, b) => asc ? (a.teamCode||'ZZZ').localeCompare(b.teamCode||'ZZZ') : (b.teamCode||'ZZZ').localeCompare(a.teamCode||'ZZZ'));
  else if (sortBy === 'ovr') list.sort((a, b) => asc ? (a.ovr||0)-(b.ovr||0) : (b.ovr||0)-(a.ovr||0));
  else if (sortBy === 'plt') list.sort((a, b) => asc ? (a.plt||'ZZZ').localeCompare(b.plt||'ZZZ') : (b.plt||'ZZZ').localeCompare(a.plt||'ZZZ'));
  // Attribute sorting
  else if (sortBy === 'speed') list.sort((a, b) => asc ? (a.attributes?.speed||0)-(b.attributes?.speed||0) : (b.attributes?.speed||0)-(a.attributes?.speed||0));
  else if (sortBy === 'shooting') list.sort((a, b) => {
    const aShoot = a.attributes ? (a.attributes.wrist_shot_power + a.attributes.wrist_shot_accuracy) / 2 : 0;
    const bShoot = b.attributes ? (b.attributes.wrist_shot_power + b.attributes.wrist_shot_accuracy) / 2 : 0;
    return asc ? aShoot - bShoot : bShoot - aShoot;
  });
  else if (sortBy === 'hands') list.sort((a, b) => {
    const aHands = a.attributes ? (a.attributes.puck_control + a.attributes.passing) / 2 : 0;
    const bHands = b.attributes ? (b.attributes.puck_control + b.attributes.passing) / 2 : 0;
    return asc ? aHands - bHands : bHands - aHands;
  });

  if (!list.length) return `<div class="empty-state">No players match filter</div>`;

  const arrow = (col) => {
    if (_plSort.by !== col) return '';
    return _plSort.dir === 'asc' ? ' ↑' : ' ↓';
  };
  const thCls = (col) => `style="cursor:pointer;user-select:none${_plSort.by===col?';color:#fff':''}"`;

  return `
    <div class="text-xs text-muted mb-8">${list.length} player${list.length !== 1 ? 's' : ''} · ${list.filter(p=>p.attributes).length} with attributes</div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th data-sort="name" ${thCls('name')}>Player${arrow('name')}</th>
          <th data-sort="pos"  ${thCls('pos')}>Pos${arrow('pos')}</th>
          <th data-sort="ovr"  ${thCls('ovr')}>OVR${arrow('ovr')}</th>
          <th data-sort="plt"  ${thCls('plt')}>PLT${arrow('plt')}</th>
          <th data-sort="speed" ${thCls('speed')} title="Speed">SPD${arrow('speed')}</th>
          <th data-sort="shooting" ${thCls('shooting')} title="Shooting (WSP+WSA avg)">SHT${arrow('shooting')}</th>
          <th data-sort="hands" ${thCls('hands')} title="Hands (PC+PAS avg)">HND${arrow('hands')}</th>
          <th data-sort="team" ${thCls('team')}>Team${arrow('team')}</th>
          <th>Manager</th>
          ${isAdmin ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${list.map(p => `
            <tr class="player-row-clickable" data-player-id="${p.id}" style="cursor:pointer">
              <td>
                <span style="display:inline-flex;align-items:center;gap:8px">
                  ${p.headshot ? `<img src="${p.headshot}" class="player-headshot-sm" loading="lazy" onerror="this.style.display='none'">` : ''}
                  <span class="font-bold">${p.name}</span>${p.number ? `<span class="text-dim text-xs">#${p.number}</span>` : ''}
                  ${p.attributes ? '<span class="text-xs" style="color:#c8a84e" title="Has SYS-DATA attributes">★</span>' : ''}
                </span>
              </td>
              <td><span class="pos-badge pos-${p.position||''}">${p.position||'—'}</span></td>
              <td>${ovrBadge(p.ovr)}</td>
              <td>${pltBadge(p.plt)}</td>
              <td>${p.attributes ? `<span class="attr-badge">${p.attributes.speed}</span>` : '<span class="text-dim">—</span>'}</td>
              <td>${p.attributes ? `<span class="attr-badge">${Math.round((p.attributes.wrist_shot_power + p.attributes.wrist_shot_accuracy) / 2)}</span>` : '<span class="text-dim">—</span>'}</td>
              <td>${p.attributes ? `<span class="attr-badge">${Math.round((p.attributes.puck_control + p.attributes.passing) / 2)}</span>` : '<span class="text-dim">—</span>'}</td>
              <td>${p.teamCode ? teamBadge(p.teamCode) : '<span class="text-dim">FA</span>'}</td>
              <td class="text-sm text-muted">${teamOwnerName(p.teamCode)}</td>
              ${isAdmin ? `<td style="white-space:nowrap;display:flex;gap:4px;align-items:center" class="action-cell"><button class="btn btn-ghost btn-sm assign-player-btn" data-pid="${p.id}">Assign</button><button class="btn btn-ghost btn-xs edit-rating-btn" data-pid="${p.id}" title="Edit OVR/PLT" style="font-size:.7rem;padding:2px 6px">✎</button></td>` : ''}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ================================================================
// 11. DRAFT
// ================================================================
function getManagerTeam(managerId) {
  return Object.entries(state.teamOwners).find(([,mid]) => mid === managerId)?.[0] || '';
}

function getDraftModuleContext() {
  return {
    getState: () => state,
    setState: (updater) => {
      const next = typeof updater === 'function' ? updater(state) : updater;
      if (next) state = next;
    },
    isAdmin: () => isAdmin,
    saveState,
    renderDraft: () => renderDraft(),
    getManagerTeam,
    managerName,
    teamBadge,
    teamLogoLg,
    ovrBadge,
    pltBadge,
    posGroup,
    positionLimits: POSITION_LIMITS,
    showModal,
    hideModal,
    toast,
    $, 
  };
}

let _draftViewMode = 'admin'; // 'admin' or 'player'

function addDraftViewToggle() {
  const container = $('section-draft');
  if (!container) return;
  
  const isAdminPlayer = isAdmin && _portalSession?.linked && _portalSession?.manager;
  console.log('[Draft Toggle] isAdmin:', isAdmin, '_portalSession:', _portalSession, 'isAdminPlayer:', isAdminPlayer);
  
  if (!isAdminPlayer) {
    console.log('[Draft Toggle] Not showing toggle - not admin+player');
    return;
  }
  
  console.log('[Draft Toggle] Adding toggle buttons');
  
  // Remove old toggle if exists
  const oldToggle = $('draft-view-toggle-container');
  if (oldToggle) oldToggle.remove();
  
  // Add toggle button at top
  const toggleHtml = `
    <div id="draft-view-toggle-container" style="position:absolute;top:16px;right:16px;z-index:100;display:flex;gap:8px">
      <button class="btn btn-sm ${_draftViewMode === 'admin' ? 'btn-primary' : 'btn-ghost'}" id="draft-view-admin">
        👨‍💼 Admin View
      </button>
      <button class="btn btn-sm ${_draftViewMode === 'player' ? 'btn-primary' : 'btn-ghost'}" id="draft-view-player">
        🏒 Player View
      </button>
    </div>
  `;
  
  container.insertAdjacentHTML('afterbegin', toggleHtml);
  
  $('draft-view-admin')?.addEventListener('click', () => {
    _draftViewMode = 'admin';
    renderDraft();
  });
  
  $('draft-view-player')?.addEventListener('click', () => {
    _draftViewMode = 'player';
    renderDraft();
  });
}

function renderDraft() {
  const container = $('section-draft');
  if (!container) return;
  
  const isAdminPlayer = isAdmin && _portalSession?.linked && _portalSession?.manager;
  
  // Render based on mode
  if (isAdminPlayer && _draftViewMode === 'player') {
    // Admin viewing as player
    renderPortalDraft();
    addDraftViewToggle();
    return;
  }
  
  if (isAdmin && window.DraftModule?.renderDraft) {
    // Admin view
    window.DraftModule.renderDraft(getDraftModuleContext());
    addDraftViewToggle();
    return;
  }
  
  if (_portalSession?.linked && _portalSession?.manager) {
    // Regular player view
    renderPortalDraft();
    return;
  }
  
  // Fallback to admin draft UI
  if (window.DraftModule?.renderDraft) {
    window.DraftModule.renderDraft(getDraftModuleContext());
  }
}

function renderLiveDraftTab() {
  if (window.DraftModule?.renderLiveDraftTab) {
    window.DraftModule.renderLiveDraftTab(getDraftModuleContext());
  }
}

function showEditPick(pickIdx) {
  if (window.DraftModule?.showEditPick) {
    window.DraftModule.showEditPick(getDraftModuleContext(), pickIdx);
  }
}

function autoDraftPick() {
  if (window.DraftModule?.autoDraftPick) {
    window.DraftModule.autoDraftPick(getDraftModuleContext());
  }
}

function showSetupLiveDraft() {
  if (window.DraftModule?.showSetupLiveDraft) {
    window.DraftModule.showSetupLiveDraft(getDraftModuleContext());
  }
}

function renderImportedDraftTab() {
  const container = $('draft-tab-content');
  if (!container) return;

  const playerPicks = state.playerDraft || [];
  if (!playerPicks.length) {
    container.innerHTML = `
      <div class="empty-state" style="padding:60px 0">
        <p>No imported draft data</p>
        ${isAdmin ? '<p class="mt-8 text-sm text-muted">Use "Import CSV" above to load picks from a spreadsheet.</p>' : ''}
      </div>`;
    return;
  }

  const rounds = [...new Set(playerPicks.map(p => p.round))].sort((a,b) => a-b);
  const teams  = [...new Set(playerPicks.map(p => p.teamCode))].sort();

  container.innerHTML = `
    <div class="text-xs text-muted mb-8">${playerPicks.length} picks &#xb7; ${rounds.length} rounds &#xb7; ${teams.length} teams</div>
    <div style="overflow-x:auto">
      <table class="draft-grid-table">
        <thead><tr>
          <th style="min-width:70px">Round</th>
          ${teams.map(tc => `<th style="min-width:100px">${teamBadge(tc)}<div class="text-xs text-dim" style="font-weight:400">${teamOwnerName(tc)}</div></th>`).join('')}
        </tr></thead>
        <tbody>
          ${rounds.map(r => `
            <tr>
              <td class="num font-bold">Rd ${r}</td>
              ${teams.map(tc => {
                const pick = playerPicks.find(p => p.round === r && p.teamCode === tc);
                return pick ? `<td class="text-sm">${pick.player}</td>` : `<td class="text-dim">&#x2014;</td>`;
              }).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderTeamDraftTab() {
  const container = $('draft-tab-content');
  if (!container) return;
  const draft          = state.draft;
  const picks          = draft.picks || [];
  const totalPicks     = draft.order.length;
  const currentPickIdx = picks.length;
  const isDone         = currentPickIdx >= totalPicks;
  const onClock        = !isDone ? draft.order[currentPickIdx] : null;
  const availableTeams = NHL_TEAMS.filter(t => !picks.some(p => p.teamCode === t.code));

  container.innerHTML = `
    ${!draft.active ? `
      <div class="empty-state" style="padding:60px 0">
        <p>No team selection draft configured</p>
        ${isAdmin ? '<p class="mt-8"><button class="btn btn-primary" id="setup-draft-btn2">Setup</button></p>' : ''}
        <p class="text-xs text-dim mt-8">Tip: Team assignments can also be set directly in Settings.</p>
      </div>` : `
    <div class="draft-layout">
      <div>
        ${onClock ? `
          <div class="card mb-16" style="border-color:var(--gold);background:rgba(185,151,91,.08)">
            <div class="text-xs text-muted mb-8">ON THE CLOCK</div>
            <div style="font-size:1.2rem;font-weight:800;color:var(--gold)">${managerName(onClock)}</div>
            <div class="text-sm text-muted mt-4">Pick #${currentPickIdx + 1} of ${totalPicks}</div>
          </div>` : `
          <div class="card mb-16" style="border-color:var(--success)">
            <div style="font-size:1.1rem;font-weight:700;color:var(--success)">Draft Complete!</div>
          </div>`}
        ${isAdmin ? `<div class="flex gap-8 mb-12">
          <button class="btn btn-secondary btn-sm" id="setup-draft-btn">Setup Draft</button>
          ${draft.active && !isDone ? `<button class="btn btn-danger btn-sm" id="reset-draft-btn">Reset Picks</button>` : ''}
        </div>` : ''}
        <div class="table-wrap">
          <table class="draft-board-table">
            <thead><tr><th style="width:50px">#</th><th>Manager</th><th>Team</th></tr></thead>
            <tbody>
              ${draft.order.map((mid, idx) => {
                const pick = picks[idx];
                const isCurrent = idx === currentPickIdx && !isDone;
                return `<tr class="${isCurrent?'current-pick-row':''}">
                  <td class="pick-number">${idx+1}</td>
                  <td style="font-weight:600">${managerName(mid)}</td>
                  <td>${pick ? teamBadge(pick.teamCode) : (isCurrent ? '<span class="pick-on-clock">Picking&#x2026;</span>' : '<span class="pick-empty">&#x2014;</span>')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="draft-sidebar">
        <div class="card">
          <div class="card-title">Available Teams (${availableTeams.length})</div>
          <div class="available-list">
            ${availableTeams.map(t => `
              <div class="draft-player-row">
                <span>${teamBadge(t.code)} <span class="text-sm text-muted" style="margin-left:6px">${t.name}</span></span>
                ${isAdmin ? `<button class="btn btn-primary btn-sm pick-team-btn" data-code="${t.code}">Pick</button>` : ''}
              </div>`).join('') || '<div class="text-dim text-sm" style="padding:12px">All teams drafted</div>'}
          </div>
        </div>
      </div>
    </div>`}
  `;

  $('setup-draft-btn')?.addEventListener('click', showDraftSetup);
  $('setup-draft-btn2')?.addEventListener('click', showDraftSetup);
  $('reset-draft-btn')?.addEventListener('click', () => {
    if (confirm('Reset all team draft picks?')) { state.draft.picks = []; saveState(); renderDraft(); }
  });

  container.querySelectorAll('.pick-team-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!isAdmin) return;
      const code = btn.dataset.code;
      const mid  = state.draft.order[state.draft.picks.length];
      state.draft.picks.push({ managerId: mid, teamCode: code });
      state.teamOwners[code] = mid;
      saveState();
      toast(`${managerName(mid)} selected ${code}`, 'success');
      renderDraft();
    });
  });
}
function showDraftCsvImport() {
  showModal('Import Player Draft', `
    <p class="text-sm text-muted mb-4"><strong>Grid format</strong> (paste directly from your spreadsheet):</p>
    <p class="text-xs text-dim mb-12">First row = team names, first column = Round labels. Copy & paste the whole table.</p>
    <p class="text-sm text-muted mb-4"><strong>Row format</strong> (alternative):</p>
    <p class="text-xs text-dim mb-12">Round,Team,Player — one pick per line (e.g. <code>1,TB,Connor McDavid</code>)</p>
    <textarea id="draft-csv-input" placeholder="Paste your draft spreadsheet here…" style="width:100%;height:220px;font-size:.75rem;font-family:monospace"></textarea>
    <button id="modal-ok" class="btn btn-primary btn-block mt-12">Import</button>
  `, () => {
    const raw = $('draft-csv-input').value.trim();
    if (!raw) return;

    // Try grid format first
    let picks = parseDraftGrid(raw);
    let format = 'grid';

    if (!picks) {
      // Fall back to row format: Round,Team,Player
      format = 'row';
      picks = [];
      let errors = 0;
      for (const line of raw.split('\n')) {
        const parts = line.split(',').map(s => s.trim());
        if (parts.length < 3) continue;
        const round = parseInt(parts[0]);
        const teamCode = parts[1].toUpperCase();
        const player = parts.slice(2).join(',').trim();
        if (!round || !player) { errors++; continue; }
        picks.push({ round, teamCode, player });
      }
    }

    if (!picks || !picks.length) { toast('No valid picks found — check format', 'error'); return; }
    state.playerDraft = picks;
    saveState();
    hideModal();
    state.draftTab = 'player';
    renderDraft();
    toast(`Imported ${picks.length} picks (${format} format)`, 'success');
  });
}

function showDraftSetup() {
  if (!state.managers.length) { toast('Add managers in Settings first', 'error'); return; }
  showModal('Setup Draft', `
    <div class="form-row">
      <label>Number of rounds</label>
      <input type="number" id="draft-rounds" value="${state.draft.rounds || 1}" min="1" max="10">
    </div>
    <div class="form-row">
      <label>Draft order (snake format)</label>
      <p class="text-xs text-dim mb-8">Managers in order for Round 1. Snake draft reverses each round.</p>
      ${state.managers.map((m,i) => `
        <div class="flex gap-8 items-center mb-8">
          <span style="color:${m.color};font-weight:700">${m.name}</span>
          <input type="number" id="draft-order-${m.id}" value="${i+1}" min="1" max="${state.managers.length}" style="width:60px">
        </div>`).join('')}
    </div>
    <button id="modal-ok" class="btn btn-primary btn-block">Start Draft</button>
  `, () => {
    const rounds = +$('draft-rounds').value || 1;
    const ordered = state.managers
      .map(m => ({ id: m.id, pos: +$(`draft-order-${m.id}`)?.value || 99 }))
      .sort((a,b) => a.pos - b.pos)
      .map(x => x.id);

    const order = [];
    for (let r = 0; r < rounds; r++) {
      const row = r % 2 === 0 ? ordered : [...ordered].reverse();
      order.push(...row);
    }
    state.draft = { active: true, rounds, order, picks: [] };
    saveState();
    hideModal();
    renderDraft();
    toast('Draft started!', 'success');
  });
}

// ================================================================
// 11. SCHEDULE
// ================================================================
function gameLabel(g) {
  if (g.week) return `Week ${g.week}`;
  if (g.date) return fmtDate(g.date);
  return '';
}

function sortGames(games) {
  return [...games].sort((a, b) => {
    const aw = a.week || 9999, bw = b.week || 9999;
    if (aw !== bw) return aw - bw;
    return (a.game || 0) - (b.game || 0);
  });
}

const PO_ROUND_LABELS = ['🏒 First Round', '🏒 Second Round', '🏒 Conference Finals', '🏆 Championship'];
function weekDateRange(w) {
  if (w >= 100) {
    const label = PO_ROUND_LABELS[w - 100] || `🏒 Playoffs Round ${w - 99}`;
    return `${label} — Playoffs`;
  }
  if (!state.scheduleStartDate) return `Week ${w}`;
  const start = new Date(state.scheduleStartDate.includes('T') ? state.scheduleStartDate : state.scheduleStartDate + 'T00:00:00');
  start.setDate(start.getDate() + (w - 1) * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Week ${w}  |  ${fmt(start)} – ${fmt(end)}`;
}

let _scheduleFilter = { team: '', status: 'upcoming' };

function renderSchedule() {
  const el_ = $('section-schedule');
  const sorted = sortGames(state.games);

  // Playoff games — always visible at top regardless of filter
  const allPlayoffGames = sorted.filter(g => g.playoff);
  const playoffByWeek = [];
  for (const g of allPlayoffGames) {
    if (_scheduleFilter.team && g.homeTeam !== _scheduleFilter.team && g.awayTeam !== _scheduleFilter.team) continue;
    const w = g.week;
    let wg = playoffByWeek.find(x => x.week === w);
    if (!wg) { wg = { week: w, games: [] }; playoffByWeek.push(wg); }
    wg.games.push(g);
  }

  // Regular season games — apply normal filters (exclude playoff games)
  let filtered = sorted.filter(g => !g.playoff);
  if (_scheduleFilter.team) {
    filtered = filtered.filter(g => g.homeTeam === _scheduleFilter.team || g.awayTeam === _scheduleFilter.team);
  }
  if (_scheduleFilter.status === 'upcoming') {
    filtered = filtered.filter(g => !g.played);
  } else if (_scheduleFilter.status === 'results') {
    filtered = filtered.filter(g => g.played);
  }

  // Group regular season games by week for display
  const weeks = [];
  for (const g of filtered) {
    const w = g.week || 0;
    let wg = weeks.find(x => x.week === w);
    if (!wg) { wg = { week: w, games: [] }; weeks.push(wg); }
    wg.games.push(g);
  }

  const managedTeams = NHL_TEAMS.filter(t => state.teamOwners[t.code]);
  const teamOpts = [
    '<option value="">All Teams</option>',
    ...managedTeams.map(t => `<option value="${t.code}" ${_scheduleFilter.team === t.code ? 'selected' : ''}>${t.code} – ${teamOwnerName(t.code)}</option>`)
  ].join('');

  const statusBtn = (status, label) => `
    <button class="btn btn-sm ${_scheduleFilter.status === status ? 'btn-primary' : 'btn-ghost'}" data-status="${status}">${label}</button>`;

  el_.innerHTML = `
    <div class="page-header">
      <h2>Schedule</h2>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        ${isAdmin ? `
          <div style="display:flex;gap:8px">
            <button class="btn btn-secondary btn-sm" id="gen-schedule-btn">Generate</button>
            <button class="btn btn-primary" id="add-game-btn">+ Add Game</button>
          </div>` : ''}
        <select id="schedule-team-filter" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;font-size:.9rem">${teamOpts}</select>
        <div style="display:flex;gap:4px;border:1px solid var(--border);border-radius:4px;padding:2px">
          ${statusBtn('upcoming', '🔜 Upcoming')}
          ${statusBtn('results', '✓ Results')}
          ${statusBtn('all', 'All')}
        </div>
      </div>
    </div>

    <div id="games-list">
      ${playoffByWeek.length ? `
        <div class="playoff-schedule-banner">
          <img src="assets/ZamboniCupPlayoffs.png" style="width:22px;height:22px;object-fit:contain;vertical-align:middle">
          <span>PLAYOFFS</span>
        </div>
        ${playoffByWeek.map(w => `
          <div class="week-block week-block-playoff">
            <div class="week-label week-label-playoff">${weekDateRange(w.week)}</div>
            ${renderGamesList(w.games)}
          </div>`).join('')}
        <div class="playoff-schedule-divider"></div>` : ''}

      ${weeks.length ? weeks.map(w => `
        <div class="week-block">
          <div class="week-label">${w.week ? weekDateRange(w.week) : 'Games'}</div>
          ${renderGamesList(w.games)}
        </div>`).join('') : `
        <div class="empty-state" style="padding:60px 0">

          <p>No games scheduled</p>
          ${isAdmin ? '<p class="mt-8"><button class="btn btn-primary" id="add-game-btn2">+ Add First Game</button></p>' : ''}
        </div>`}
    </div>
  `;

  $('add-game-btn')?.addEventListener('click', showAddGame);
  $('add-game-btn2')?.addEventListener('click', showAddGame);
  $('gen-schedule-btn')?.addEventListener('click', showGenerateSchedule);

  // Filter controls
  $('schedule-team-filter')?.addEventListener('change', e => {
    _scheduleFilter.team = e.target.value;
    renderSchedule();
  });

  document.querySelectorAll('[data-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      _scheduleFilter.status = btn.dataset.status;
      renderSchedule();
    });
  });
}

function renderGamesList(games) {
  return games.map(g => {
    const hw = g.played && +g.homeScore > +g.awayScore;
    const aw = g.played && +g.awayScore > +g.homeScore;
    const homeMgr = state.managers.find(m => m.id === state.teamOwners[g.homeTeam]);
    const awayMgr = state.managers.find(m => m.id === state.teamOwners[g.awayTeam]);
    const hasStats = g.played && !!(homeMgr?.zamboniTag && awayMgr?.zamboniTag);
    return `
      <div class="game-card ${hasStats ? 'game-card-stats' : ''}" data-gid="${g.id}">
        <div class="game-teams">
          <span class="${hw?'winner-team':g.played?'loser-team':''}" style="display:inline-flex;align-items:center;gap:8px">${teamLogoLg(g.homeTeam,42)} <span><span style="font-weight:700">${g.homeTeam}</span> <span class="text-xs text-muted">${teamOwnerName(g.homeTeam)}</span></span></span>
          <span class="vs-sep">vs</span>
          <span class="${aw?'winner-team':g.played?'loser-team':''}" style="display:inline-flex;align-items:center;gap:8px">${teamLogoLg(g.awayTeam,42)} <span><span style="font-weight:700">${g.awayTeam}</span> <span class="text-xs text-muted">${teamOwnerName(g.awayTeam)}</span></span></span>
          ${g.isMakeup ? `<span class="badge-mu">MU</span>` : ''}
          ${g.notes ? `<span class="text-xs text-dim">${g.notes}</span>` : ''}
        </div>
        <div class="game-score ${g.played?'':'pending'}">
          ${g.played ? `${g.homeScore}–${g.awayScore}${g.ot?' OT':''}` : 'TBD'}
        </div>
        <div class="game-actions">
          ${hasStats ? '<span class="game-stats-btn" title="View box score">📊</span>' : ''}
          ${isAdmin ? `
            <button class="btn btn-accent btn-sm enter-score-btn" data-gid="${g.id}">
              ${g.played ? 'Edit' : 'Score'}
            </button>
            <button class="btn btn-ghost btn-sm del-game-btn" data-gid="${g.id}">✕</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

document.addEventListener('click', e => {
  if (e.target.classList.contains('enter-score-btn')) {
    if (!isAdmin) return;
    const gid = e.target.dataset.gid;
    const g = state.games.find(x => x.id === gid);
    if (g) showEnterScore(g);
  }
  if (e.target.classList.contains('del-game-btn')) {
    if (!isAdmin) return;
    const gid = e.target.dataset.gid;
    if (confirm('Delete this game?')) {
      state.games = state.games.filter(g => g.id !== gid);
      saveState();
      renderSchedule();
    }
  }
  // Box score click on schedule game cards
  const card = e.target.closest('.game-card-stats');
  if (card && !e.target.closest('button') && !e.target.closest('.enter-score-btn') && !e.target.closest('.del-game-btn')) {
    const g = state.games.find(x => x.id === card.dataset.gid);
    if (g) showGameBoxScore(g);
  }
});

function showAddGame() {
  const nextWeek = Math.max(1, ...state.games.map(g => g.week || 0), 0) + (state.games.length ? 0 : 0);
  const managedTeams = NHL_TEAMS.filter(t => state.teamOwners[t.code]);
  const teamList = managedTeams.length ? managedTeams : NHL_TEAMS;
  const opts = teamList.map(t => `<option value="${t.code}">${t.code} – ${t.name}</option>`).join('');

  showModal('Add Game', `
    <div class="form-row">
      <label>Week</label>
      <input type="number" id="game-week" value="${nextWeek}" min="1" max="99">
    </div>
    <div class="form-row">
      <label>Home Team</label>
      <select id="game-home">${opts}</select>
    </div>
    <div class="form-row">
      <label>Away Team</label>
      <select id="game-away">${opts}</select>
    </div>
    <div class="form-row">
      <label>Notes (optional)</label>
      <input type="text" id="game-notes" placeholder="Playoff game, etc.">
    </div>
    <div class="form-row" style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="game-makeup" style="width:auto">
      <label for="game-makeup" style="text-transform:none">Makeup game <span class="badge-mu" style="margin-left:4px">MU</span></label>
    </div>
    <button id="modal-ok" class="btn btn-primary btn-block mt-12">Add Game</button>
  `, () => {
    const home = $('game-home').value, away = $('game-away').value;
    if (home === away) { toast('Home and away teams must differ', 'error'); return; }
    const week = Math.max(1, +$('game-week').value || 1);
    const gamesInWeek = state.games.filter(g => g.week === week).length;
    state.games.push({ id: uid(), week, game: gamesInWeek + 1, homeTeam: home, awayTeam: away, notes: $('game-notes').value, played: false, homeScore: 0, awayScore: 0, ot: false, isMakeup: !!$('game-makeup')?.checked });
    saveState();
    hideModal();
    renderSchedule();
    toast('Game added', 'success');
  });
}

function showEnterScore(g) {
  showModal('Enter Score', `
    <div style="display:grid;grid-template-columns:1fr 40px 1fr;gap:8px;align-items:center;margin-bottom:16px">
      <div style="text-align:center">
        <div style="font-weight:700;margin-bottom:6px">${teamBadge(g.homeTeam)}</div>
        <input type="number" id="score-home" value="${g.homeScore||0}" min="0" max="30" style="width:100%;text-align:center;font-size:1.4rem;font-weight:700">
      </div>
      <div style="text-align:center;color:var(--text-dim);font-weight:700">–</div>
      <div style="text-align:center">
        <div style="font-weight:700;margin-bottom:6px">${teamBadge(g.awayTeam)}</div>
        <input type="number" id="score-away" value="${g.awayScore||0}" min="0" max="30" style="width:100%;text-align:center;font-size:1.4rem;font-weight:700">
      </div>
    </div>
    <div class="form-row" style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="score-ot" ${g.ot?'checked':''} style="width:auto">
      <label for="score-ot" style="text-transform:none">Overtime / Shootout</label>
    </div>
    <div class="form-row" style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="score-makeup" ${g.isMakeup?'checked':''} style="width:auto">
      <label for="score-makeup" style="text-transform:none">Makeup game <span class="badge-mu" style="margin-left:4px">MU</span></label>
    </div>
    <button id="modal-ok" class="btn btn-primary btn-block mt-12">Save Result</button>
  `, () => {
    const hs = +$('score-home').value, as_ = +$('score-away').value;
    if (hs === as_) { toast('Scores cannot be tied', 'error'); return; }
    g.homeScore = hs; g.awayScore = as_; g.ot = $('score-ot').checked; g.played = true;
    g.isMakeup = !!$('score-makeup')?.checked;
    g.postedAt = new Date().toISOString();
    if (g.playoff) recalcPlayoffBracket(); else saveState();
    hideModal();
    renderSchedule();
    if (g.playoff && currentSection === 'playoffs') renderPlayoffs();
    toast('Score saved!', 'success');
    _apiFetch('/api/admin/bot/score-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(g),
    }).catch(() => {});
  });
}

function showGenerateSchedule() {
  // Default start date = next Monday
  const today = new Date();
  const daysUntilMon = (8 - today.getDay()) % 7 || 7;
  const nextMon = new Date(today);
  nextMon.setDate(today.getDate() + daysUntilMon);
  const defaultDate = nextMon.toISOString().slice(0, 10);

  showModal('Generate Schedule', `
    <div class="form-row">
      <label>Season Start Date (Week 1 begins)</label>
      <input type="date" id="gs-startdate" value="${state.scheduleStartDate || defaultDate}">
      <p class="text-xs text-dim mt-4">Used to display date ranges per week (e.g. Week 1 | Mar 22 – Mar 28)</p>
    </div>
    <div class="form-row">
      <label>Number of Weeks</label>
      <input type="number" id="gs-weeks" value="19" min="1" max="52">
    </div>
    <div class="form-row">
      <label>Games Per Week</label>
      <input type="number" id="gs-gpw" value="16" min="1" max="50">
      <p class="text-xs text-dim mt-4">Tip: 32 teams = 16 games/week for everyone to play once</p>
    </div>
    <div class="form-row">
      <label>Start at Week #</label>
      <input type="number" id="gs-startweek" value="1" min="1" max="99">
    </div>
    <button id="modal-ok" class="btn btn-primary btn-block mt-16">Generate</button>
  `, () => {
    const startDate = $('gs-startdate').value || defaultDate;
    const weeks     = Math.max(1, +$('gs-weeks').value || 19);
    const gpw       = Math.max(1, +$('gs-gpw').value   || 16);
    const startWeek = Math.max(1, +$('gs-startweek').value || 1);
    state.scheduleStartDate = startDate;

    const teams = Object.keys(state.teamOwners);
    if (teams.length < 2) { toast('Need at least 2 teams assigned to managers', 'error'); return; }

    // Build all matchup pairs (round-robin)
    const pairs = [];
    for (let i = 0; i < teams.length; i++)
      for (let j = i + 1; j < teams.length; j++)
        pairs.push([teams[i], teams[j]]);

    // Shuffle pairs (Fisher-Yates)
    for (let i = pairs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
    }

    if (state.games.length > 0 && !confirm(`${state.games.length} games already exist. Append new schedule?`)) return;

    let pairIdx = 0;
    const newGames = [];
    for (let w = 0; w < weeks; w++) {
      for (let g = 0; g < gpw; g++) {
        if (pairIdx >= pairs.length) pairIdx = 0;
        const [home, away] = pairs[pairIdx++];
        newGames.push({ id: uid(), week: startWeek + w, game: g + 1, homeTeam: home, awayTeam: away, played: false, homeScore: 0, awayScore: 0, ot: false, notes: '' });
      }
    }

    state.games.push(...newGames);
    saveState();
    hideModal();
    renderSchedule();
    toast(`Generated ${newGames.length} games across ${weeks} weeks`, 'success');
  });
}

// ================================================================
// 12. SCORES
// ================================================================
let _scoresFilter = { week: 'all' };

function renderScores() {
  const el_ = $('section-scores');
  const played = state.games
    .filter(g => g.played)
    .sort((a, b) => (b.postedAt || b.playedAt || b.date || '').localeCompare(a.postedAt || a.playedAt || a.date || ''));

  const hasPlayoffs = played.some(g => g.playoff);
  const regWeeks = [...new Set(played.filter(g => !g.playoff).map(g => g.week).filter(Boolean))].sort((a, b) => a - b);

  if (_scoresFilter.week !== 'all' && _scoresFilter.week !== 'playoffs' && !regWeeks.includes(_scoresFilter.week)) {
    _scoresFilter.week = 'all';
  }

  const visible = _scoresFilter.week === 'all'     ? played
                : _scoresFilter.week === 'playoffs' ? played.filter(g => g.playoff)
                : played.filter(g => g.week === _scoresFilter.week && !g.playoff);

  el_.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Scores</h2>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
      <button class="btn btn-xs ${_scoresFilter.week === 'all' ? 'btn-primary' : 'btn-ghost'} scores-wk-btn" data-wk="all">All</button>
      ${hasPlayoffs ? `<button class="btn btn-xs ${_scoresFilter.week === 'playoffs' ? 'btn-primary' : 'btn-ghost'} scores-wk-btn" data-wk="playoffs">🏆 Playoffs</button>` : ''}
      ${regWeeks.map(w => `<button class="btn btn-xs ${_scoresFilter.week === w ? 'btn-primary' : 'btn-ghost'} scores-wk-btn" data-wk="${w}">Wk ${w}</button>`).join('')}
    </div>
    <div class="panel" style="padding:0">
      ${visible.length ? visible.map(g => {
        const homeWin = +g.homeScore > +g.awayScore;
        const homeMgr = state.managers.find(m => m.id === state.teamOwners[g.homeTeam]);
        const awayMgr = state.managers.find(m => m.id === state.teamOwners[g.awayTeam]);
        const hasZamboniStats = !!(homeMgr?.zamboniTag && awayMgr?.zamboniTag);
        const hasPlayerStats = !!(g.playerStats && g.playerStats.length > 0);
        const hasStats = hasZamboniStats || hasPlayerStats;
        return `
        <div class="sb-game ${hasStats ? 'sb-game-stats' : ''}" data-gid="${g.id}">
          <div class="sb-team ${homeWin ? 'sb-winner' : 'sb-loser'}">
            <div class="sb-logo">${teamLogoLg(g.homeTeam, 52)}</div>
            <div class="sb-info">
              <div class="sb-code">${g.homeTeam}</div>
              <div class="sb-mgr">${teamOwnerName(g.homeTeam)}</div>
            </div>
            <div class="sb-score ${homeWin ? 'sb-score-win' : ''}">${g.homeScore}</div>
          </div>
          <div class="sb-sep">
            <span class="sb-ot">${g.ot ? 'OT' : ''}</span>
            <span class="sb-vs">Final</span>
            ${g.isMakeup ? `<span class="badge-mu">MU</span>` : ''}
            ${g.playoff && g.notes ? `<span class="sb-posted" style="color:var(--gold,#c8a84e)">${g.notes}</span>` : (g.week ? `<span class="sb-posted">Wk ${g.week}</span>` : '')}
            ${g.postedAt ? `<span class="sb-posted">${fmtDateTime(g.postedAt)}</span>` : ''}
            ${hasStats ? '<span class="sb-stats-hint">📊 Box Score</span>' : ''}
          </div>
          <div class="sb-team ${!homeWin ? 'sb-winner' : 'sb-loser'}">
            <div class="sb-score ${!homeWin ? 'sb-score-win' : ''}">${g.awayScore}</div>
            <div class="sb-info" style="text-align:right">
              <div class="sb-code">${g.awayTeam}</div>
              <div class="sb-mgr">${teamOwnerName(g.awayTeam)}</div>
            </div>
            <div class="sb-logo">${teamLogoLg(g.awayTeam, 52)}</div>
          </div>
        </div>`;
      }).join('') : '<div class="empty-state"><span class="empty-icon">🏒</span>No scores posted yet</div>'}
    </div>
  `;

  el_.querySelectorAll('.scores-wk-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const wk = btn.dataset.wk;
      _scoresFilter.week = wk === 'all' ? 'all' : wk === 'playoffs' ? 'playoffs' : +wk;
      renderScores();
    });
  });

  // Click any game card with stats to open box score modal
  el_.querySelectorAll('.sb-game-stats').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('button')) return; // don't intercept admin buttons
      const g = state.games.find(x => x.id === card.dataset.gid);
      if (g) showGameBoxScore(g);
    });
  });
}

// ================================================================
// 13. STANDINGS
// ================================================================
function renderStandings() {
  const el_ = $('section-standings');
  const po   = state.playoffs;

  // ── Build enriched rows from league games ─────────────────────────────────
  const played = state.games.filter(g => g.played && !g.playoff);

  if (!played.length) {
    el_.innerHTML = `
      <div class="page-header"><h2>Standings</h2></div>
      <div class="empty-state" style="padding:80px 0">
        <p>No games played yet</p>
        <p class="text-dim text-sm mt-8">Add games and enter scores to see standings</p>
      </div>`;
    return;
  }

  const map = {};
  const ensure = code => {
    if (!map[code]) map[code] = {
      code, teamName: NHL_TEAMS.find(t=>t.code===code)?.name || code,
      gp:0, w:0, l:0, ot:0, pts:0, gf:0, ga:0, rw:0,
      homeGp:0, homeW:0, homeL:0, homeOtl:0,
      awayGp:0, awayW:0, awayL:0, awayOtl:0,
      results:[],
    };
    return map[code];
  };

  const byDate = [...played].sort((a,b)=>
    (a.postedAt||a.date||'').localeCompare(b.postedAt||b.date||''));

  byDate.forEach(g => {
    const hs = +g.homeScore, as_ = +g.awayScore;
    const h = ensure(g.homeTeam), a = ensure(g.awayTeam);
    h.gp++; a.gp++;
    h.gf += hs; h.ga += as_; a.gf += as_; a.ga += hs;
    h.homeGp++; a.awayGp++;
    if (g.ot) {
      if (hs > as_) {
        h.w++; h.pts+=2; h.rw++; h.homeW++;
        a.ot++; a.pts+=1; a.awayOtl++;
        h.results.push('W'); a.results.push('OTL');
      } else {
        a.w++; a.pts+=2; a.rw++; a.awayW++;
        h.ot++; h.pts+=1; h.homeOtl++;
        a.results.push('W'); h.results.push('OTL');
      }
    } else {
      if (hs > as_) {
        h.w++; h.pts+=2; h.rw++; h.homeW++;
        a.l++; a.awayL++;
        h.results.push('W'); a.results.push('L');
      } else {
        a.w++; a.pts+=2; a.rw++; a.awayW++;
        h.l++; h.homeL++;
        a.results.push('W'); h.results.push('L');
      }
    }
  });

  let rows = Object.values(map).filter(t => t.gp > 0);
  rows.forEach(t => {
    t.diff    = t.gf - t.ga;
    t.pct     = t.gp ? t.pts / (t.gp * 2) : 0;
    t.gfPerGp = t.gp ? t.gf / t.gp : 0;
    t.gaPerGp = t.gp ? t.ga / t.gp : 0;
    t.homeRec = `${t.homeW}-${t.homeL}${t.homeOtl?'-'+t.homeOtl:''}`;
    t.awayRec = `${t.awayW}-${t.awayL}${t.awayOtl?'-'+t.awayOtl:''}`;
    t.last5   = t.results.slice(-5);
    const last = t.results[t.results.length-1];
    let stk = 0;
    for (let i=t.results.length-1; i>=0; i--) {
      if (t.results[i]===last) stk++; else break;
    }
    t.streak = last ? { type:last, count:stk } : null;
  });

  // ── Sort ──────────────────────────────────────────────────────────────────
  // Default: pts desc, tiebreak rw, then diff
  const defaultSort = (a,b) => b.pts-a.pts || b.rw-a.rw || (b.gf-b.ga)-(a.gf-a.ga);
  rows.sort((a,b) => {
    const col = _statSort.col;
    if (!col || col === 'pts') return _statSort.dir * defaultSort(a,b) * -1 || defaultSort(a,b);
    const av = a[col] ?? 0, bv = b[col] ?? 0;
    const cmp = typeof av==='string' ? av.localeCompare(bv) : bv - av;
    return _statSort.dir * cmp;
  });

  // Playoff cutline index (top 16)
  const CUT = 16;

  // ── Clinching / Elimination math ──────────────────────────────────────────
  const clinch = {}; // { teamCode: 'x' | 'e' }
  if (rows.length > CUT) {
    // games remaining per team (unplayed regular season)
    const rem = {};
    rows.forEach(t => {
      rem[t.code] = state.games.filter(
        g => !g.played && !g.playoff && (g.homeTeam === t.code || g.awayTeam === t.code)
      ).length;
    });
    // max possible pts per team
    const maxP = {};
    rows.forEach(t => { maxP[t.code] = t.pts + rem[t.code] * 2; });

    // sorted by default standings order (pts already sorted above)
    const lastIn   = rows[CUT - 1]; // 16th — last playoff team
    const firstOut = rows[CUT];     // 17th — best team outside

    rows.forEach((t, i) => {
      if (i < CUT) {
        // Clinched: even the best outside team can't reach this team's pts
        if (firstOut && t.pts > maxP[firstOut.code]) clinch[t.code] = 'x';
      } else {
        // Eliminated: winning everything still can't reach 16th's current pts
        if (maxP[t.code] < lastIn.pts) clinch[t.code] = 'e';
      }
    });
  }

  // ── Column leader highlights ───────────────────────────────────────────────
  const best = col => {
    const asc = col === 'gaPerGp' || col === 'ga';
    const vals = rows.map(r => r[col]).filter(v => typeof v==='number' && !isNaN(v));
    return vals.length ? (asc ? Math.min(...vals) : Math.max(...vals)) : null;
  };
  const leaders = {};
  ['w','rw','gf','ga','diff','pct','gfPerGp','gaPerGp'].forEach(c => leaders[c]=best(c));
  const isLead = (col, val) => leaders[col]!=null && val===leaders[col];

  // ── Render helpers ────────────────────────────────────────────────────────
  const thSort = (col, label, tip='') => {
    const active = _statSort.col === col;
    const arrow  = active ? (_statSort.dir===-1 ? 'sort-desc' : 'sort-asc') : '';
    return `<th class="ct-th-num ${arrow}" data-sort="${col}" title="${tip}">${label}</th>`;
  };

  const formDot = r => {
    const cls = r==='W'?'form-w':r==='OTL'?'form-otl':'form-l';
    return `<span class="form-dot ${cls}">${r==='OTL'?'O':r}</span>`;
  };

  const strkBadge = s => {
    if (!s) return '—';
    const cls = s.type==='W'?'streak-w':s.type==='OTL'?'streak-otl':'streak-l';
    return `<span class="streak-badge ${cls}">${s.type}${s.count}</span>`;
  };

  const numCell = (col, val, display) => {
    const gold = isLead(col, val) ? 'stat-leader' : '';
    return `<td class="ct-td-num ${gold}">${display ?? val}</td>`;
  };

  const fmtDiff = d => `<span class="${d>0?'diff-pos':d<0?'diff-neg':''}">${d>0?'+':''}${d}</span>`;
  const fmtPct  = p => p.toFixed(3).replace(/^0/,'');

  // ── Table ─────────────────────────────────────────────────────────────────
  el_.innerHTML = `
    <div class="page-header">
      <h2>Standings</h2>
      ${po?`<button class="btn btn-accent btn-sm" onclick="navigate('playoffs')" style="display:flex;align-items:center;gap:6px"><img src="assets/ZamboniCupPlayoffs.png" style="width:18px;height:18px;object-fit:contain;border-radius:2px"> Zamboni Cup ▶</button>`:''}
    </div>
    <div class="table-wrap mt-20">
      <table class="stn-table">
        <thead><tr>
          <th class="ct-th-rank">#</th>
          <th class="ct-th-team" style="text-align:left">Team</th>
          ${thSort('gp',     'GP',     'Games played')}
          ${thSort('w',      'W',      'Wins')}
          <th class="ct-th-num">L</th>
          <th class="ct-th-num">OTL</th>
          ${thSort('pts',    'PTS',    'Points')}
          ${thSort('pct',    'P%',     'Points percentage')}
          ${thSort('rw',     'RW',     'Regulation wins')}
          ${thSort('gf',     'GF',     'Goals for')}
          ${thSort('ga',     'GA',     'Goals against')}
          ${thSort('diff',   'DIFF',   'Goal differential')}
          ${thSort('gfPerGp','GF/GP',  'Goals for per game')}
          ${thSort('gaPerGp','GA/GP',  'Goals against per game')}
          <th class="ct-th-num" title="Home record">HOME</th>
          <th class="ct-th-num" title="Away record">AWAY</th>
          <th title="Last 5 games" style="text-align:center">L5</th>
          <th class="ct-th-num" title="Current streak">STK</th>
        </tr></thead>
        <tbody>
          ${rows.map((t,i) => {
            const c = teamColor(t.code);
            const inPo  = i < CUT;
            const cutCls = i < CUT ? 'stn-in' : 'stn-out';
            const lineRow = i === CUT-1 ? ' stn-cutline' : '';
            return `
              <tr class="ct-row ${cutCls}${lineRow}">
                <td class="ct-td-rank">${i+1}</td>
                <td class="ct-td-team">
                  ${teamLogoLg(t.code, 34)}
                  <div class="ct-team-info">
                    <span class="ct-fullname" style="color:${c}">${t.code}</span>
                    <span class="ct-mgr">${teamOwnerName(t.code)}</span>
                  </div>
                  ${clinch[t.code] === 'x' ? `<span class="clinch-badge clinch-x" title="Clinched playoff spot">X</span>` : ''}
                  ${clinch[t.code] === 'e' ? `<span class="clinch-badge clinch-e" title="Eliminated">E</span>` : ''}
                </td>
                ${numCell('gp',     t.gp,      t.gp)}
                ${numCell('w',      t.w,       t.w)}
                <td class="ct-td-num">${t.l}</td>
                <td class="ct-td-num">${t.ot}</td>
                ${numCell('pts',    t.pts,     `<strong>${t.pts}</strong>`)}
                ${numCell('pct',    t.pct,     fmtPct(t.pct))}
                ${numCell('rw',     t.rw,      t.rw)}
                ${numCell('gf',     t.gf,      t.gf)}
                ${numCell('ga',     t.ga,      t.ga)}
                ${numCell('diff',   t.diff,    fmtDiff(t.diff))}
                ${numCell('gfPerGp',t.gfPerGp, t.gfPerGp.toFixed(2))}
                ${numCell('gaPerGp',t.gaPerGp, t.gaPerGp.toFixed(2))}
                <td class="ct-td-num stat-split">${t.homeRec}</td>
                <td class="ct-td-num stat-split">${t.awayRec}</td>
                <td class="stat-form">${t.last5.map(formDot).join('')}</td>
                <td class="ct-td-num">${strkBadge(t.streak)}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  // Sort on header click — re-render with new sort
  el_.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      _statSort.dir = (_statSort.col === col) ? _statSort.dir * -1 : -1;
      _statSort.col = col;
      renderStandings();
    });
  });
}

// ================================================================
// 14. STATS (NHL.com style leaderboards)
// ================================================================
let _statsFilter = { category: 'skaters', stat: 'points', team: 'all' };

function renderStats() {
  const el_ = $('section-stats');
  
  // Get all player stats from games
  const allPlayerStats = [];
  state.games.forEach(g => {
    if (g.playerStats && g.playerStats.length > 0) {
      g.playerStats.forEach(ps => {
        allPlayerStats.push({
          ...ps,
          gameId: g.id,
          gameDate: g.postedAt || g.playedAt || g.date
        });
      });
    }
  });
  
  // Aggregate stats by player
  const playerMap = {};
  allPlayerStats.forEach(ps => {
    const key = ps.playerId;
    if (!playerMap[key]) {
      playerMap[key] = {
        playerId: ps.playerId,
        playerName: ps.playerName,
        teamCode: ps.teamCode,
        position: ps.position,
        gamesPlayed: 0,
        goals: 0,
        assists: 0,
        points: 0,
        pim: 0,
        plusMinus: 0,
        // Goalie stats
        wins: 0,
        losses: 0,
        otLosses: 0,
        shotsAgainst: 0,
        saves: 0,
        goalsAgainst: 0,
        shutouts: 0
      };
    }
    
    const p = playerMap[key];
    p.gamesPlayed++;
    
    if (ps.position === 'G') {
      // Goalie stats
      p.shotsAgainst += ps.shotsAgainst || 0;
      p.saves += ps.saves || 0;
      p.goalsAgainst += ps.goalsAgainst || 0;
      if (ps.shutout) p.shutouts++;
      
      // Determine W/L
      const game = state.games.find(g => g.id === ps.gameId);
      if (game) {
        const isHome = game.homeTeam === ps.teamCode;
        const teamScore = isHome ? game.homeScore : game.awayScore;
        const oppScore = isHome ? game.awayScore : game.homeScore;
        if (teamScore > oppScore) p.wins++;
        else if (game.ot) p.otLosses++;
        else p.losses++;
      }
    } else {
      // Skater stats
      p.goals += ps.goals || 0;
      p.assists += ps.assists || 0;
      p.points += (ps.points || 0);
      p.pim += ps.pim || 0;
      p.plusMinus += ps.plusMinus || 0;
    }
  });
  
  const players = Object.values(playerMap);
  const skaters = players.filter(p => p.position !== 'G');
  const goalies = players.filter(p => p.position === 'G');
  
  // Calculate goalie averages
  goalies.forEach(g => {
    g.gaa = g.gamesPlayed > 0 ? (g.goalsAgainst / g.gamesPlayed).toFixed(2) : '0.00';
    g.svPct = g.shotsAgainst > 0 ? (g.saves / g.shotsAgainst) : 0;
    g.svPctDisplay = g.svPct.toFixed(3).replace('0.', '.');
  });
  
  const teams = ['all', ...Object.keys(state.teamOwners).sort()];
  
  const isSkaters = _statsFilter.category === 'skaters';
  const dataSet = isSkaters ? skaters : goalies;
  
  // Filter by team
  const filtered = _statsFilter.team === 'all' 
    ? dataSet 
    : dataSet.filter(p => p.teamCode === _statsFilter.team);
  
  // Sort by selected stat
  const sortKey = _statsFilter.stat;
  filtered.sort((a, b) => {
    const aVal = a[sortKey] || 0;
    const bVal = b[sortKey] || 0;
    if (sortKey === 'gaa') return aVal - bVal; // Lower is better
    return bVal - aVal; // Higher is better
  });
  
  const top50 = filtered.slice(0, 50);
  
  const teamFilter = teams.map(t => 
    `<option value="${t}" ${_statsFilter.team === t ? 'selected' : ''}>${t === 'all' ? 'All Teams' : t}</option>`
  ).join('');
  
  const skaterStats = [
    { key: 'points', label: 'Points' },
    { key: 'goals', label: 'Goals' },
    { key: 'assists', label: 'Assists' },
    { key: 'plusMinus', label: '+/-' },
    { key: 'pim', label: 'PIM' }
  ];
  
  const goalieStats = [
    { key: 'wins', label: 'Wins' },
    { key: 'gaa', label: 'GAA' },
    { key: 'svPct', label: 'SV%' },
    { key: 'shutouts', label: 'SO' }
  ];
  
  const statButtons = (isSkaters ? skaterStats : goalieStats).map(s =>
    `<button class="stat-filter-btn ${_statsFilter.stat === s.key ? 'active' : ''}" data-stat="${s.key}">${s.label}</button>`
  ).join('');
  
  // Featured leaders (top 3)
  const topLeaders = top50.slice(0, 3);
  
  el_.innerHTML = `
    <div class="stats-hero">
      <h1 class="stats-title">Statistics</h1>
      <div class="stats-category-tabs">
        <button class="stats-tab ${isSkaters ? 'active' : ''}" data-category="skaters">Skaters</button>
        <button class="stats-tab ${!isSkaters ? 'active' : ''}" data-category="goalies">Goalies</button>
      </div>
    </div>
    
    <div class="stats-filters-bar">
      <select id="stats-team-filter" class="stats-select">
        ${teamFilter}
      </select>
      <div class="stats-stat-filters">
        ${statButtons}
      </div>
    </div>
    
    ${topLeaders.length > 0 ? `
      <div class="stats-leaders-section">
        <h2 class="stats-section-title">${isSkaters ? 'Skaters' : 'Goalies'} ›</h2>
        <div class="stats-leaders-grid">
          ${topLeaders.map((p, i) => renderLeaderCard(p, i + 1, isSkaters)).join('')}
        </div>
      </div>
    ` : ''}
    
    <div class="stats-table-section">
      <div class="stats-table-header">
        <h3>All Leaders</h3>
      </div>
      ${top50.length === 0 ? '<div class="empty-state"><span class="empty-icon">📊</span>No stats recorded yet</div>' : 
        isSkaters ? renderSkatersTable(top50) : renderGoaliesTable(top50)}
    </div>
  `;
  
  // Event listeners
  el_.querySelectorAll('.stats-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _statsFilter.category = btn.dataset.category;
      _statsFilter.stat = btn.dataset.category === 'skaters' ? 'points' : 'wins';
      renderStats();
    });
  });
  
  el_.querySelectorAll('.stat-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _statsFilter.stat = btn.dataset.stat;
      renderStats();
    });
  });
  
  $('stats-team-filter')?.addEventListener('change', (e) => {
    _statsFilter.team = e.target.value;
    renderStats();
  });
}

function renderLeaderCard(player, rank, isSkater) {
  const statLabel = isSkater ? 'POINTS' : 'GAA';
  const statValue = isSkater ? player.points : player.gaa;
  const bgColor = rank === 1 ? '#1e40af' : rank === 2 ? '#1e3a8a' : '#1e293b';
  
  // Get headshot from state.players
  const fullPlayer = state.players.find(p => String(p.id) === String(player.playerId));
  const headshot = fullPlayer?.headshot || '';
  
  return `
    <div class="leader-card" style="background: ${bgColor}">
      ${headshot ? `<img src="${headshot}" class="leader-headshot" loading="lazy" onerror="this.style.display='none'">` : ''}
      <div class="leader-content">
        <div class="leader-rank">T${rank}.</div>
        <div class="leader-info">
          <div class="leader-name">${player.playerName}</div>
          <div class="leader-team">${player.teamCode} • ${player.position}</div>
        </div>
        <div class="leader-stat">
          <div class="leader-stat-label">${statLabel}</div>
          <div class="leader-stat-value">${statValue}</div>
        </div>
        ${isSkater ? `
          <div class="leader-substats">
            <span>${player.goals}G</span>
            <span>${player.assists}A</span>
            <span>${player.gamesPlayed}GP</span>
          </div>
        ` : `
          <div class="leader-substats">
            <span>${player.wins}W</span>
            <span>${player.svPctDisplay} SV%</span>
            <span>${player.shutouts}SO</span>
          </div>
        `}
      </div>
    </div>
  `;
}

function renderSkatersTable(players) {
  return `
    <table class="stats-table">
      <thead>
        <tr>
          <th class="text-left">Rank</th>
          <th class="text-left">Player</th>
          <th class="text-left">Team</th>
          <th>Pos</th>
          <th>GP</th>
          <th>G</th>
          <th>A</th>
          <th class="highlight">PTS</th>
          <th>+/-</th>
          <th>PIM</th>
        </tr>
      </thead>
      <tbody>
        ${players.map((p, i) => `
          <tr>
            <td class="rank">${i + 1}</td>
            <td class="text-left player-name"><strong>${p.playerName}</strong></td>
            <td class="text-left">${p.teamCode}</td>
            <td>${p.position}</td>
            <td>${p.gamesPlayed}</td>
            <td>${p.goals}</td>
            <td>${p.assists}</td>
            <td class="highlight"><strong>${p.points}</strong></td>
            <td class="${p.plusMinus > 0 ? 'text-success' : p.plusMinus < 0 ? 'text-danger' : ''}">${p.plusMinus > 0 ? '+' : ''}${p.plusMinus}</td>
            <td>${p.pim}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderGoaliesTable(players) {
  return `
    <table class="stats-table">
      <thead>
        <tr>
          <th class="text-left">Rank</th>
          <th class="text-left">Player</th>
          <th class="text-left">Team</th>
          <th>GP</th>
          <th class="highlight">W</th>
          <th>L</th>
          <th>OTL</th>
          <th>SA</th>
          <th>SV</th>
          <th>GA</th>
          <th>GAA</th>
          <th>SV%</th>
          <th>SO</th>
        </tr>
      </thead>
      <tbody>
        ${players.map((p, i) => `
          <tr>
            <td class="rank">${i + 1}</td>
            <td class="text-left player-name"><strong>${p.playerName}</strong></td>
            <td class="text-left">${p.teamCode}</td>
            <td>${p.gamesPlayed}</td>
            <td class="highlight"><strong>${p.wins}</strong></td>
            <td>${p.losses}</td>
            <td>${p.otLosses}</td>
            <td>${p.shotsAgainst}</td>
            <td>${p.saves}</td>
            <td>${p.goalsAgainst}</td>
            <td>${p.gaa}</td>
            <td>${p.svPctDisplay}</td>
            <td>${p.shutouts}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderPlayoffs() {
  const el_ = $('section-playoffs');
  const po = state.playoffs;

  if (!po?.rounds?.length) {
    el_.innerHTML = `
      <div class="playoffs-wrap">
        <div class="playoff-hero">
          <img src="assets/ZamboniCupPlayoffs.png" class="playoff-hero-logo" alt="Zamboni Cup Playoffs">
          <div class="playoff-hero-text">
            <div class="playoff-hero-title">ZAMBONI CUP</div>
            <div class="playoff-hero-sub">PLAYOFFS</div>
          </div>
        </div>
        <div class="empty-state" style="padding:60px 0">
          <p>Playoffs have not started yet.</p>
          <p class="text-dim text-sm mt-8">Complete the regular season to begin the bracket.</p>
          ${isAdmin ? `<button class="btn btn-accent mt-16" onclick="initPlayoffs()">🏒 Generate Bracket from Standings</button>` : ''}
        </div>
      </div>`;
    return;
  }

  const champion = (() => {
    const last = po.rounds[po.rounds.length - 1];
    return last?.series?.[0]?.winner || null;
  })();

  el_.innerHTML = `
    <div class="playoffs-wrap">

      <div class="playoff-hero">
        <img src="assets/ZamboniCupPlayoffs.png" class="playoff-hero-logo" alt="Zamboni Cup Playoffs">
        <div class="playoff-hero-text">
          <div class="playoff-hero-title">ZAMBONI CUP</div>
          <div class="playoff-hero-sub">PLAYOFFS</div>
        </div>
      </div>

      ${champion ? `
      <div class="champion-banner">
        <span class="champion-label">🏆 ZAMBONI CUP CHAMPION</span>
        <img src="assets/ZamboniCupPlayoffs.png" class="champion-cup-icon" alt="Zamboni Cup">
        ${teamLogoLg(champion, 56)}
        <div class="champion-info">
          <div class="champion-team">${champion}</div>
          <div class="champion-mgr">${teamOwnerName(champion)}</div>
        </div>
      </div>` : ''}

      <div style="display:flex;align-items:center;justify-content:space-between;padding:0 28px 12px">
        <button class="btn btn-ghost btn-sm" onclick="navigate('schedule')" title="View playoff games in Schedule">📅 Schedule</button>
        ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="initPlayoffs()">↺ Regenerate from Standings</button>` : '<span></span>'}
      </div>

      <div class="bracket-rounds">
      ${po.rounds.map(round => `
        <div class="bracket-round">
          <div class="bracket-round-name">${round.name}</div>
          ${round.series.length === 0
            ? `<div style="color:var(--text-dim);font-size:.75rem;padding:12px 0;opacity:.5">TBD</div>`
            : round.series.map(s => {
            const w = s.winner;
            const winTo = s.winTo || round.winTo || 2;
            const s1 = s.seed1 ? `<span class="bracket-seed">${s.seed1}</span>` : '';
            const s2 = s.seed2 ? `<span class="bracket-seed">${s.seed2}</span>` : '';
            const ri = po.rounds.indexOf(round);
            const si = round.series.indexOf(s);
            return `
            <div class="bracket-series">
              <div class="bracket-team ${w === s.team1 ? 'bracket-winner' : w ? 'bracket-loser' : ''}">
                <div style="display:flex;align-items:center;gap:8px;flex:1">
                  ${s1}${teamLogoLg(s.team1, 36)}
                  <div>
                    <div style="font-family:'Oswald';font-weight:700;font-size:.88rem;color:${w===s.team1?'#fff':'var(--chrome-bright)'}">${s.team1}</div>
                    <div class="bracket-manager">${teamOwnerName(s.team1)}</div>
                  </div>
                </div>
                <span class="bracket-wins ${w===s.team1?'bracket-wins-w':''}">${s.wins1}</span>
              </div>
              <div class="bracket-team ${w === s.team2 ? 'bracket-winner' : w ? 'bracket-loser' : ''}">
                <div style="display:flex;align-items:center;gap:8px;flex:1">
                  ${s2}${teamLogoLg(s.team2, 36)}
                  <div>
                    <div style="font-family:'Oswald';font-weight:700;font-size:.88rem;color:${w===s.team2?'#fff':'var(--chrome-bright)'}">${s.team2}</div>
                    <div class="bracket-manager">${teamOwnerName(s.team2)}</div>
                  </div>
                </div>
                <span class="bracket-wins ${w===s.team2?'bracket-wins-w':''}">${s.wins2}</span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;padding:3px 10px 5px">
                <span style="font-size:.58rem;color:var(--text-dim);letter-spacing:1px">BO${winTo*2-1}</span>
                ${w
                  ? `<span style="font-size:.6rem;color:var(--gold);letter-spacing:.5px;font-weight:700">${w} advances ✓</span>`
                  : isAdmin
                    ? `<button class="btn-po-game" onclick="enterPlayoffGame(${ri},${si})">+ Enter Game</button>`
                    : `<span style="font-size:.58rem;color:var(--text-dim)">In progress</span>`
                }
              </div>
            </div>`;
          }).join('')}
        </div>`).join('')}
    </div>
    </div>
  `;
}

// ================================================================
// 13. TRADES
// ================================================================
const DEFAULT_RULES = `## Schedule & Format
Games start Sunday, March 22nd. Each week you are matched up with 3 different opponents. It is up to you to schedule your games with each other throughout the week and complete them before the next Sunday.

We will play every opponent once — 3 games per week for 10 weeks. Top 16 out of 32 teams will make the playoffs.

## Game Completion
You must complete your 3 games for the week (starting Sunday) by **Saturday 11:59 PM EST**.

If for whatever reason you and your opponent are not able to complete games that week, you will be granted a week extension. If games are not completed that week, the player who was not able to provide the better availability will be subject to a **FF (3-0 DNF)** in the standings.

Consistently not being able to show up will result in your league spot being removed.

## Roster Rules
Players must play on the **same roster**. Do not move your backup goalie in — it will cause a loop.

## Playoff Format
**Top 16** advance to playoffs. Single elimination bracket — 1 seed plays 16 seed and so on.

- Top 16: **Best of 3**
- Top 8: **Best of 5**
- Top 4: **Best of 5**
- Finals: **Best of 7**

## Trades
Trades can be made before the season starts. In-season trade **deadline: Friday 8 PM EST**. Trades made during the season will not be pushed through until after **Week 5**. All trades are reviewed for fairness.

## Disconnect Procedure
### Penalties
- 1 disconnect: No penalty
- 2 disconnects: 2-minute minor
- 3 disconnects: Forfeit
*(Game loop does not count as a disconnect)*

### 1st Period
If a disconnect occurs in the 1st period, run the clock down to the time of disconnect, recreate the score, and play the rest of the game.

### 2nd Period
If a disconnect occurs in the 2nd period, play the 1st period of the next game as the 2nd period. Add 5 minutes of in-game time to the clock to account for slow 3rd period minutes.

*Example: disconnect at 10 minutes in the 2nd period → start next game at 15 minutes left in the 1st period, play until the 2nd period ends.*

### 3rd Period
If a disconnect occurs in the 3rd period, play the 1st period of the next game as the 3rd period. Add 5 minutes of game time to account for slow last minute.

*Example: disconnect at 10 minutes left → start next game at 15:00 in the 1st period.*

If the disconnect occurs between **16–20 minutes** left in the 3rd period, just start the 1st period of the next game as the 3rd. We will deal with the lost time.

## General Rules
- **No blatant defensive zone ragging of the puck.** A game decided to be a rag will result in a loss.
- **Loop bug:** If a player scores and the game loops after — reverting the goal — that player must be awarded the goal. (Very rare)
- **Game settings:** 5-minute periods · Rules: NHL · Penalties: On · Injuries: Off permitted
- **Shootout rule:** If a game goes to a shootout, players have the option to back out and start a new game — next goal wins. Both players must agree; otherwise the shootout decides the winner.`;

function renderRules() {
  const el_ = $('section-rules');
  const text = state.rules ?? DEFAULT_RULES;

  // Parse markdown-like text into sections
  const sections = [];
  let current = null;
  text.split('\n').forEach(line => {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { title: line.slice(3).trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  });
  if (current) sections.push(current);

  const renderBody = (lines) => {
    const html = [];
    let inList = false;
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('### ')) {
        if (inList) { html.push('</ul>'); inList = false; }
        html.push(`<div class="rules-sub-heading">${trimmed.slice(4)}</div>`);
      } else if (trimmed.startsWith('- ')) {
        if (!inList) { html.push('<ul class="rules-list">'); inList = true; }
        html.push(`<li>${renderInline(trimmed.slice(2))}</li>`);
      } else if (trimmed === '') {
        if (inList) { html.push('</ul>'); inList = false; }
      } else if (trimmed.startsWith('*') && trimmed.endsWith('*')) {
        if (inList) { html.push('</ul>'); inList = false; }
        html.push(`<p class="rules-note">${renderInline(trimmed.slice(1,-1))}</p>`);
      } else {
        if (inList) { html.push('</ul>'); inList = false; }
        html.push(`<p class="rules-p">${renderInline(trimmed)}</p>`);
      }
    });
    if (inList) html.push('</ul>');
    return html.join('');
  };

  const renderInline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

  el_.innerHTML = `
    <div class="rules-hero">
      <img src="assets/zamboni.png" alt="Zamboni" class="rules-hero-zamboni">
      <div class="rules-hero-text">
        <h2 style="margin:0;font-family:'Oswald',sans-serif;font-size:1.6rem;letter-spacing:2px">LEAGUE RULES</h2>
        <div style="font-size:.72rem;color:var(--text-dim);letter-spacing:1.5px;text-transform:uppercase;margin-top:4px">NHL Legacy League</div>
      </div>
      ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="navigate('settings')" style="margin-left:auto">✏ Edit Rules</button>` : ''}
    </div>
    <div class="rules-grid">
      ${sections.map(s => `
        <div class="rules-card conf-standings">
          <div class="conf-header">
            <span class="conf-title">${s.title}</span>
          </div>
          <div class="rules-body">${renderBody(s.body)}</div>
        </div>`).join('')}
    </div>
  `;
}

function renderTrades() {
  const el_ = $('section-trades');
  const sorted = [...state.trades].sort((a,b) => (b.date||'').localeCompare(a.date||''));

  el_.innerHTML = `
    <div class="page-header">
      <h2>Trades</h2>
      ${isAdmin ? `<button class="btn btn-primary" id="new-trade-btn">+ Record Trade</button>` : ''}
    </div>

    ${!isAdmin ? `<div class="info-banner">Login as admin to record trades.</div>` : ''}

    <div id="trades-list">
      ${sorted.length ? sorted.map(t => renderTradeCard(t)).join('') : `
        <div class="empty-state" style="padding:60px 0">
          
          <p>No trades yet</p>
          ${isAdmin ? '<p class="mt-8"><button class="btn btn-primary" id="new-trade-btn2">+ Record First Trade</button></p>' : ''}
        </div>`}
    </div>
  `;

  $('new-trade-btn')?.addEventListener('click', showNewTrade);
  $('new-trade-btn2')?.addEventListener('click', showNewTrade);
}

function renderTradeCard(t) {
  const fmtName = p => resolvePlayerName(p, 'Player #');
  const toList = v => Array.isArray(v) ? v : (v ? v.split(',').map(s => s.trim()).filter(Boolean) : []);
  const give = toList(t.playersSent).map(p => `<div class="text-sm">${fmtName(p)}</div>`).join('');
  const recv = toList(t.playersReceived).map(p => `<div class="text-sm">${fmtName(p)}</div>`).join('');
  return `
    <div class="trade-card">
      <div class="trade-header">
        <div class="trade-teams">
          ${teamBadge(t.fromTeam)} <span class="trade-arrow">⇌</span> ${teamBadge(t.toTeam)}
        </div>
        <div class="flex gap-8 items-center">
          <span class="trade-date">${fmtDate(t.date)}</span>
          ${isAdmin ? `
            <button class="btn btn-ghost btn-sm reverse-trade-btn" data-tid="${t.id}" title="Undo trade — moves players back" style="font-size:.75rem">🔄 Reverse</button>
            <button class="btn btn-ghost btn-sm del-trade-btn" data-tid="${t.id}" title="Delete record only (no roster changes)">✕</button>` : ''}
        </div>
      </div>
      <div class="trade-players">
        <div class="trade-side">
          <div class="trade-side-label">${t.fromTeam} sends</div>
          ${give || '<div class="text-dim text-sm">—</div>'}
        </div>
        <div class="trade-side">
          <div class="trade-side-label">${t.toTeam} sends</div>
          ${recv || '<div class="text-dim text-sm">—</div>'}
        </div>
      </div>
      ${t.notes ? `<div class="text-xs text-dim mt-8">${t.notes}</div>` : ''}
    </div>`;
}

document.addEventListener('click', e => {
  if (e.target.classList.contains('del-trade-btn')) {
    if (!isAdmin) return;
    const tid = e.target.dataset.tid;
    if (confirm('Delete trade record only? (no roster changes)')) {
      state.trades = state.trades.filter(t => t.id !== tid);
      saveState();
      renderTrades();
    }
  }

  if (e.target.classList.contains('reverse-trade-btn')) {
    if (!isAdmin) return;
    const tid = e.target.dataset.tid;
    const t = state.trades.find(x => x.id === tid);
    if (!t) return;

    const toList = v => Array.isArray(v) ? v : (v ? v.split(',').map(s => s.trim()).filter(Boolean) : []);
    const give = toList(t.playersSent);
    const recv = toList(t.playersReceived);

    const fromNames = [...give, ...recv].map(n => n).join(', ') || 'no players';
    if (!confirm(`Reverse this trade?\n\n${t.fromTeam} → ${t.toTeam}\nSent: ${give.join(', ') || '—'}\nReceived: ${recv.join(', ') || '—'}\n\nThis will move all players back to their original teams.`)) return;

    // Step 1: manually move players back to their original sides
    let moved = 0;
    give.forEach(name => { const p = state.players.find(x => x.name === name); if (p) { p.teamCode = t.fromTeam; moved++; } });
    recv.forEach(name => { const p = state.players.find(x => x.name === name); if (p) { p.teamCode = t.toTeam; moved++; } });
    // Step 2: remove this trade, then replay remaining trades on top
    state.trades = state.trades.filter(x => x.id !== tid);
    applyTradeHistory();
    saveState();
    renderTrades();
    toast(`Trade reversed — ${moved} player${moved !== 1 ? 's' : ''} moved back`, 'success');
  }
});

function applyTradeHistory() {
  // Replay all trades in chronological order to keep player teamCodes consistent.
  // Called after recording a trade AND after any NHL API roster refresh.
  const toList = v => Array.isArray(v) ? v : (v ? [v] : []);
  state.trades
    .slice()
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .forEach(t => {
      toList(t.playersSent).forEach(name => {
        const p = state.players.find(x => x.name === name);
        if (p) p.teamCode = t.toTeam;
      });
      toList(t.playersReceived).forEach(name => {
        const p = state.players.find(x => x.name === name);
        if (p) p.teamCode = t.fromTeam;
      });
    });
}

function showNewTrade() {
  const managedTeams = NHL_TEAMS.filter(t => state.teamOwners[t.code]);
  const teamList = managedTeams.length ? managedTeams : NHL_TEAMS;
  const teamOpts = () => teamList.map(t =>
    `<option value="${t.code}">${t.code} – ${t.name}${managedTeams.length ? ` (${teamOwnerName(t.code)})` : ''}</option>`
  ).join('');
  const today = new Date().toISOString().slice(0,10);

  showModal('Record Trade', `
    <div class="form-row"><label>Date</label><input type="date" id="trade-date" value="${today}"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <div class="form-row"><label>Team A</label><select id="trade-team-a">${teamOpts()}</select></div>
        <div class="form-row">
          <label>Team A sends</label>
          <div id="trade-give-list" class="player-checklist"></div>
        </div>
      </div>
      <div>
        <div class="form-row"><label>Team B</label>
          <select id="trade-team-b"><option value="">— Select team —</option>${teamOpts()}</select>
        </div>
        <div class="form-row">
          <label>Team B sends</label>
          <div id="trade-recv-list" class="player-checklist"></div>
        </div>
      </div>
    </div>
    <div class="form-row mt-8"><label>Notes</label><input type="text" id="trade-notes" placeholder="Optional notes"></div>
    <button id="modal-ok" class="btn btn-primary btn-block mt-12">Record Trade</button>
  `, () => {
    const fromTeam = $('trade-team-a').value, toTeam = $('trade-team-b').value;
    if (!toTeam) { toast('Select Team B', 'error'); return; }
    if (fromTeam === toTeam) { toast('Teams must differ', 'error'); return; }
    const give = [...document.querySelectorAll('#trade-give-list input:checked')].map(c => c.dataset.name);
    const recv = [...document.querySelectorAll('#trade-recv-list input:checked')].map(c => c.dataset.name);
    const tradeRecord = {
      id: uid(), date: $('trade-date').value,
      fromTeam, toTeam, playersSent: give, playersReceived: recv,
      notes: $('trade-notes').value,
    };
    state.trades.push(tradeRecord);
    applyTradeHistory();
    saveState();
    hideModal();
    renderTrades();
    toast('Trade recorded!', 'success');
    _apiFetch('/api/bot/trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tradeRecord),
    }).catch(() => {});
  });

  const fillList = (teamCode, listId) => {
    const container = $(listId);
    if (!container) return;
    if (!teamCode) { container.innerHTML = '<div class="text-dim text-sm" style="padding:8px">Select a team first</div>'; return; }
    const players = state.players.filter(p => p.teamCode === teamCode).sort((a,b) => a.name.localeCompare(b.name));
    container.innerHTML = players.length
      ? players.map(p => `<label class="player-check-item"><input type="checkbox" data-name="${p.name}"> ${p.name}</label>`).join('')
      : `<div class="text-dim text-sm" style="padding:8px">No players on this team</div>`;
  };

  setTimeout(() => {
    $('modal-box')?.classList.add('modal-wide');
    const ta = $('trade-team-a'), tb = $('trade-team-b');
    if (!ta) return;
    fillList(ta.value, 'trade-give-list');
    fillList('', 'trade-recv-list');
    ta.addEventListener('change', e => fillList(e.target.value, 'trade-give-list'));
    tb?.addEventListener('change', e => fillList(e.target.value, 'trade-recv-list'));
  }, 0);
}

// ================================================================
// ================================================================
// 14. SEASON SIMULATION
// ================================================================
function simGameScore() {
  const g = [1,1,2,2,2,3,3,3,3,4,4,4,5,5,6];
  const rnd = () => g[Math.floor(Math.random() * g.length)];
  let h = rnd(), a = rnd();
  if (h === a) { Math.random() < .5 ? h++ : a++; return { homeScore: h, awayScore: a, ot: true }; }
  return { homeScore: h, awayScore: a, ot: false };
}

function randomPairing(teams) {
  const s = [...teams].sort(() => Math.random() - .5);
  const pairs = [];
  for (let i = 0; i + 1 < s.length; i += 2) pairs.push([s[i], s[i+1]]);
  return pairs;
}

function simDraft() {
  if (!state.managers.length || !state.players.length) return false;
  const shuf = arr => [...arr].sort(() => Math.random() - .5);
  const pools = {
    F: shuf(state.players.filter(p => posGroup(p.position) === 'F')),
    D: shuf(state.players.filter(p => posGroup(p.position) === 'D')),
    G: shuf(state.players.filter(p => posGroup(p.position) === 'G')),
  };
  const order = shuf(state.managers.map(m => m.id));
  // 21 rounds: 12 F, 7 D, 2 G — snake
  const roundTypes = [...Array(12).fill('F'), ...Array(7).fill('D'), ...Array(2).fill('G')];
  const picks = [];
  let pickNum = 1;
  roundTypes.forEach((pt, ri) => {
    const ro = ri % 2 === 0 ? order : [...order].reverse();
    ro.forEach(mid => {
      const teamCode = getManagerTeam(mid);
      const player = pools[pt].shift();
      if (!player) return;
      player.teamCode = teamCode;
      picks.push({ round: ri+1, pick: pickNum++, managerId: mid, teamCode, playerId: player.id, playerName: player.name, position: player.position });
    });
  });
  state.liveDraft = { active: true, rounds: 21, order, picks };
  return true;
}

function simRegularSeason(weeks = 10, gpw = 3) {
  const teams = Object.keys(state.teamOwners);
  if (teams.length < 2) return 0;
  const games = [];
  for (let w = 1; w <= weeks; w++) {
    for (let g = 1; g <= gpw; g++) {
      randomPairing(teams).forEach(([home, away]) => {
        const r = simGameScore();
        games.push({ id: uid(), week: w, game: g, homeTeam: home, awayTeam: away, homeScore: r.homeScore, awayScore: r.awayScore, played: true, ot: r.ot, notes: '', playoff: false });
      });
    }
  }
  state.games = games;
  return games.length;
}

// ── Recalc bracket wins from real game scores ────────────────────
function recalcPlayoffBracket() {
  if (!state.playoffs?.rounds?.length) return;
  const rounds = state.playoffs.rounds;

  rounds.forEach((round, ri) => {
    const winTo = round.winTo || 2;
    const poWeek = 100 + ri;

    round.series.forEach(s => {
      if (!s.team1 || !s.team2) return;

      // Count wins from ALL played playoff games between these two teams
      const seriesGames = state.games.filter(g =>
        g.playoff && g.played &&
        ((g.homeTeam === s.team1 && g.awayTeam === s.team2) ||
         (g.homeTeam === s.team2 && g.awayTeam === s.team1))
      );

      let w1 = 0, w2 = 0;
      seriesGames.forEach(g => {
        if (g.homeScore > g.awayScore) {
          g.homeTeam === s.team1 ? w1++ : w2++;
        } else {
          g.awayTeam === s.team1 ? w1++ : w2++;
        }
      });

      s.wins1 = w1;
      s.wins2 = w2;
      s.winner = w1 >= winTo ? s.team1 : w2 >= winTo ? s.team2 : null;

      // Series still active — make sure there's an unplayed game stub waiting
      if (!s.winner) {
        const hasPending = state.games.some(g =>
          g.playoff && !g.played &&
          ((g.homeTeam === s.team1 && g.awayTeam === s.team2) ||
           (g.homeTeam === s.team2 && g.awayTeam === s.team1))
        );
        if (!hasPending) {
          const gameNum = w1 + w2 + 1;
          state.games.push({
            id: uid(), week: poWeek, game: gameNum,
            homeTeam: s.team1, awayTeam: s.team2,
            played: false, homeScore: 0, awayScore: 0, ot: false,
            playoff: true, notes: `${round.name} – Game ${gameNum}`,
          });
        }
      }
    });

    // Round complete → populate & generate game stubs for next round
    const allDone = round.series.length > 0 && round.series.every(s => s.winner);
    if (allDone && rounds[ri + 1] !== undefined) {
      const nextRound = rounds[ri + 1];
      const winners = round.series.map(s => s.winner);

      if (!nextRound.series.length) {
        // Re-seed: sort winners by their advancing seed (best remaining vs worst remaining)
        const advancers = round.series.map(s => ({
          team: s.winner,
          seed: s.winner === s.team1 ? (s.seed1 || 99) : (s.seed2 || 99),
        }));
        advancers.sort((a, b) => a.seed - b.seed);
        const n = advancers.length;
        const nextSeries = [];
        for (let i = 0; i < Math.floor(n / 2); i++) {
          const t1 = advancers[i].team, t2 = advancers[n - 1 - i].team;
          if (t1 && t2) nextSeries.push({
            team1: t1, team2: t2, wins1: 0, wins2: 0, winner: null,
            winTo: nextRound.winTo || 2,
            seed1: advancers[i].seed, seed2: advancers[n - 1 - i].seed,
          });
        }
        nextRound.series = nextSeries;

        // Generate Game 1 stubs for next round so players can submit
        const nextWeek = 100 + ri + 1;
        nextSeries.forEach(s => {
          state.games.push({
            id: uid(), week: nextWeek, game: 1,
            homeTeam: s.team1, awayTeam: s.team2,
            played: false, homeScore: 0, awayScore: 0, ot: false,
            playoff: true, notes: `${nextRound.name} – Game 1`,
          });
        });
      }
    }
  });

  saveState();
}

// ── Enter a real playoff game score ─────────────────────────────
function enterPlayoffGame(ri, si) {
  const round = state.playoffs?.rounds?.[ri];
  const s = round?.series?.[si];
  if (!s) return;

  const winTo = s.winTo || round.winTo || 2;
  const gameNum = (s.wins1 + s.wins2) + 1;

  showModal(`Game ${gameNum} — ${s.team1} vs ${s.team2}`, `
    <div style="text-align:center;font-size:.72rem;color:var(--text-dim);margin-bottom:14px;letter-spacing:1px">
      ${round.name} · Best of ${winTo * 2 - 1} · ${s.wins1}–${s.wins2} in series
    </div>
    <div style="display:grid;grid-template-columns:1fr 40px 1fr;gap:8px;align-items:center;margin-bottom:16px">
      <div style="text-align:center">
        <div style="font-weight:700;margin-bottom:6px">${teamBadge(s.team1)}</div>
        <input type="number" id="po-score-1" value="0" min="0" max="20"
          style="width:100%;text-align:center;font-size:1.6rem;font-weight:800;padding:8px;background:var(--input-bg);border:1px solid var(--border);border-radius:6px;color:#fff">
      </div>
      <div style="text-align:center;color:var(--text-dim);font-weight:700;font-size:1.2rem">–</div>
      <div style="text-align:center">
        <div style="font-weight:700;margin-bottom:6px">${teamBadge(s.team2)}</div>
        <input type="number" id="po-score-2" value="0" min="0" max="20"
          style="width:100%;text-align:center;font-size:1.6rem;font-weight:800;padding:8px;background:var(--input-bg);border:1px solid var(--border);border-radius:6px;color:#fff">
      </div>
    </div>
    <div class="form-row" style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="po-ot" style="width:auto">
      <label for="po-ot" style="text-transform:none">Overtime / Shootout</label>
    </div>
    <button id="modal-ok" class="btn btn-primary btn-block mt-12">Save Game Result</button>
  `, () => {
    const hs = +$('po-score-1').value, as_ = +$('po-score-2').value;
    if (hs === as_) { toast('Scores cannot be tied', 'error'); return; }

    state.games.push({
      id: uid(),
      week: 100 + ri,
      game: gameNum,
      homeTeam: s.team1,
      awayTeam: s.team2,
      homeScore: hs,
      awayScore: as_,
      ot: !!$('po-ot').checked,
      played: true,
      playoff: true,
      notes: `${round.name} – Game ${gameNum}`,
    });

    const savedGame = state.games[state.games.length - 1];

    recalcPlayoffBracket();
    hideModal();
    renderPlayoffs();
    toast('Playoff game saved!', 'success');
    _apiFetch('/api/admin/bot/score-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savedGame),
    }).catch(() => {});
  });
}

function initPlayoffs() {
  // Build real empty bracket seeded 1v16, 2v15 … from live standings
  if (state.playoffs?.rounds?.length) {
    if (!confirm('Playoffs bracket already exists. Regenerate from current standings? This will clear all existing playoff data.')) return;
  }
  const ps = calcStandings().slice(0, 16);
  if (ps.length < 16) { toast('Need at least 16 teams in standings', 'error'); return; }

  const fmt = state.playoffFormat?.length ? state.playoffFormat : [
    { name: 'First Round',        winTo: 2 },
    { name: 'Second Round',       winTo: 3 },
    { name: 'Conference Finals',  winTo: 3 },
    { name: 'Championship',       winTo: 4 },
  ];

  // Sequential seeding: 1v16, 2v15, 3v14, 4v13, 5v12, 6v11, 7v10, 8v9
  const r1Series = [
    [0,15],[1,14],[2,13],[3,12],[4,11],[5,10],[6,9],[7,8]
  ].map(([a,b]) => ({
    team1: ps[a].teamCode, team2: ps[b].teamCode,
    wins1: 0, wins2: 0, winner: null,
    winTo: fmt[0].winTo,
    seed1: a + 1, seed2: b + 1,
  }));

  // Build rounds: only R1 is populated; subsequent rounds are empty shells
  const rounds = fmt.map((r, ri) => ({
    name: r.name,
    winTo: r.winTo,
    series: ri === 0 ? r1Series : [],
  }));

  // Remove any existing unplayed playoff games
  state.games = state.games.filter(g => !(g.playoff && !g.played));

  // Generate Game 1 stubs for R1 so players can submit via the normal flow
  r1Series.forEach(s => {
    state.games.push({
      id: uid(), week: 100, game: 1,
      homeTeam: s.team1, awayTeam: s.team2,
      played: false, homeScore: 0, awayScore: 0, ot: false,
      playoff: true, notes: `${rounds[0].name} – Game 1`,
    });
  });

  state.playoffs = { rounds };

  // Reset schedule team filter so playoff games are immediately visible
  _scheduleFilter.team = '';

  saveState();

  const stubCount = r1Series.length;
  toast(`Playoff bracket generated — ${stubCount} games added to Schedule ✓`, 'success');
  renderPlayoffs();
}

function simPlayoffs() {
  // Top 16 → R1 Bo3 | Top 8 → R2 Bo5 | Top 4 → R3 Bo5 | Final Bo7
  const ps = calcStandings().slice(0, 16);
  if (ps.length < 2) return;

  const fmt = state.playoffFormat?.length ? state.playoffFormat : [
    { name: 'Round 1',    winTo: 2 },
    { name: 'Round 2',    winTo: 3 },
    { name: 'Semifinals', winTo: 3 },
    { name: 'Finals',     winTo: 4 },
  ];
  const baseWeek = Math.max(0, ...state.games.map(g => g.week || 0)) + 1;
  const roundDefs = fmt.map((r, i) => ({ name: r.name, week: baseWeek + i, winTo: r.winTo }));

  // Seed 16: 1v16, 8v9, 4v13, 5v12, 2v15, 7v10, 3v14, 6v11
  const seed = i => ps[i] || null;
  let matchups = [
    [seed(0),seed(15)], [seed(7),seed(8)],
    [seed(3),seed(12)], [seed(4),seed(11)],
    [seed(1),seed(14)], [seed(6),seed(9)],
    [seed(2),seed(13)], [seed(5),seed(10)],
  ].filter(([a,b]) => a && b);

  const playoffRounds = [];
  for (let ri = 0; ri < roundDefs.length && matchups.length > 0; ri++) {
    const { name, week, winTo } = roundDefs[ri];
    const series = [];
    const winners = [];
    matchups.forEach(([t1, t2]) => {
      if (!t1 || !t2) return;
      let w1 = 0, w2 = 0, gNum = 0;
      while (w1 < winTo && w2 < winTo) {
        gNum++;
        let { homeScore: hs, awayScore: as, ot } = simGameScore();
        if (hs === as) { Math.random() < .5 ? hs++ : as++; ot = true; }
        state.games.push({ id: uid(), week, game: gNum, homeTeam: t1.teamCode, awayTeam: t2.teamCode, homeScore: hs, awayScore: as, played: true, ot, notes: `${name} – Game ${gNum}`, playoff: true });
        if (hs > as) w1++; else w2++;
      }
      const winner = w1 > w2 ? t1 : t2;
      winners.push(winner);
      series.push({ team1: t1.teamCode, team2: t2.teamCode, wins1: w1, wins2: w2, winner: winner.teamCode });
    });
    playoffRounds.push({ name, week, series });
    const next = [];
    for (let i = 0; i + 1 < winners.length; i += 2) next.push([winners[i], winners[i+1]]);
    matchups = next;
  }
  state.playoffs = { rounds: playoffRounds };
}

async function simulateFullSeason() {
  if (!confirm('This will overwrite all draft picks, games, and playoff data with simulated results. Continue?')) return;
  // Ensure managers + team assignments
  if (Object.keys(state.teamOwners).length < 32) {
    LEAGUE_DEFAULTS.managers.forEach((name, i) => {
      if (!state.managers.find(m => m.name === name))
        state.managers.push({ id: uid(), name, color: MANAGER_COLORS[i % MANAGER_COLORS.length] });
    });
    LEAGUE_DEFAULTS.managers.forEach(name => {
      const m = state.managers.find(m => m.name === name);
      if (!m) return;
      const tc = LEAGUE_DEFAULTS.teamMap[name];
      if (tc) state.teamOwners[tc] = m.id;
    });
  }
  // Ensure players
  if (!state.players.length) {
    toast('Fetching NHL rosters first…', 'info');
    await fetchNHLRosters();
    if (!state.players.length) { toast('Failed to load players', 'error'); return; }
  }
  toast('Simulating snake draft (21 rounds × 32 teams)…', 'info');
  simDraft();
  toast('Generating 10-week regular season…', 'info');
  const gameCount = simRegularSeason(10, 3);
  toast('Simulating playoffs (top 16 teams, 4 rounds)…', 'info');
  state.playoffs = null;
  simPlayoffs();
  saveState();
  toast(`Done — ${gameCount} regular season games + 3 playoff rounds`, 'success');
  renderSection('standings');
}

// ================================================================
// 15. SETTINGS
// ================================================================
const NHL_API_CODE_MAP = {
  EAS:'VGK', WES:'SEA', PHX:'UTA'
};

const POSITION_LIMITS = { F: 12, D: 7, G: 2 };
function posGroup(pos) {
  if (pos === 'G') return 'G';
  if (pos === 'D') return 'D';
  return 'F'; // C, L, R, LW, RW, W
}

// ── Zamboni API helpers ──────────────────────────────────────────────────────

async function fetchZamboniData(path) {
  try {
    const r = await fetch(`/api/zamboni/${path}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function _getZamboniPlayers() {
  if (_zamboniPlayers) return _zamboniPlayers;
  const data = await fetchZamboniData('players');
  if (!data) { _zamboniPlayers = []; return _zamboniPlayers; }
  // Zamboni returns array of objects with a 'gamertag' field, or plain strings
  _zamboniPlayers = Array.isArray(data)
    ? data.map(p => (typeof p === 'string' ? p : p.gamertag || p.name || '')).filter(Boolean)
    : [];
  return _zamboniPlayers;
}

// ── Zamboni shared helpers ───────────────────────────────────────────────────

/** Format seconds as M:SS */
const zbFmtToa = s => s != null ? `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}` : '—';
/** Format penalty-minute seconds as M:SS */
const zbFmtPim = s => s != null ? `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}` : '—';
/** Dash for null/empty values */
const zbDash   = v => (v != null && v !== '') ? v : '—';
/** Proportional percentage (returns 50 when both zero) */
const zbPct    = (a, b) => { const t=(a||0)+(b||0); return t ? Math.round((a||0)/t*100) : 50; };

/** SVG donut chart with left and right arcs colored by team */
function zbDonut(lVal, rVal, label, lColor, rColor) {
  const lp = zbPct(lVal, rVal), rp = 100 - lp;
  const r = 28, cx = 36, cy = 36, sw = 10;
  const circ = 2 * Math.PI * r;
  const lDash = circ * lp / 100, rDash = circ * rp / 100;
  const lc = lColor || '#c0392b', rc = rColor || '#2c5f8a';
  return `
    <div class="zb-donut-block">
      <svg width="72" height="72" viewBox="0 0 72 72">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="${sw}"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${lc}" stroke-width="${sw}"
          stroke-dasharray="${lDash} ${circ}" stroke-linecap="butt"
          transform="rotate(-90 ${cx} ${cy})"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${rc}" stroke-width="${sw}"
          stroke-dasharray="${rDash} ${circ}" stroke-linecap="butt"
          stroke-dashoffset="${-lDash}"
          transform="rotate(-90 ${cx} ${cy})"/>
      </svg>
      <div class="zb-donut-label">${label}</div>
      <div class="zb-donut-pcts">
        <span style="color:${lc}">${lp}%</span>
        <span style="color:${rc}">${rp}%</span>
      </div>
    </div>`;
}

/**
 * Render a full Zamboni box score card.
 * lh / rh are Zamboni history entries; lMgr / rMgr are manager objects;
 * lTeam / rTeam are NHL team codes; mgrRecord is { tag: 'W-L[-OTL]' }.
 * Returns a <div class="zb-game-card"> string.
 */
function zbRenderCard(lh, rh, lMgr, rMgr, lTeam, rTeam) {
  const lScore = lh.scor ?? 0;
  const rScore = rh ? (rh.scor ?? 0) : (lh.opponent_score ?? '?');
  const lWin   = lScore > rScore;
  const rWin   = rScore > lScore;
  const isOt   = !!(lh.otg > 0 || rh?.otg > 0);
  const isDisc = !!(lh.disc || rh?.disc);

  const dispDate = lh.created_at
    ? new Date(lh.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
    : '';

  // League records from the schedule — not Zamboni stats
  const standings = calcStandings();
  const lSt = standings.find(s => s.teamCode === lTeam);
  const rSt = standings.find(s => s.teamCode === rTeam);
  const fmtRec = st => st ? `${st.w}-${st.l}${st.ot ? '-'+st.ot : ''}` : '';
  const lRec = fmtRec(lSt);
  const rRec = fmtRec(rSt);

  // Team colors for bars & donuts
  const lColor = teamColor(lTeam);
  const rColor = teamColor(rTeam);

  // Proper NHL SVG logos via teamLogoLg
  const lLogo = lTeam ? teamLogoLg(lTeam, 64) : '';
  const rLogo = rTeam ? teamLogoLg(rTeam, 64) : '';

  const statDefs = [
    { label:'Goals',           l:lScore,                  r:rScore,                  lRaw:+lScore,    rRaw:+rScore },
    { label:'Total Shots',     l:zbDash(lh.shts),         r:zbDash(rh?.shts),        lRaw:lh.shts,    rRaw:rh?.shts },
    { label:'Hits',            l:zbDash(lh.hits),         r:zbDash(rh?.hits),        lRaw:lh.hits,    rRaw:rh?.hits },
    { label:'Time on Attack',  l:zbFmtToa(lh.toa),        r:zbFmtToa(rh?.toa),       lRaw:lh.toa,     rRaw:rh?.toa },
    { label:'Faceoffs Won',    l:zbDash(lh.fo),           r:zbDash(rh?.fo),          lRaw:lh.fo,      rRaw:rh?.fo },
    { label:'Power Play',      l:`${zbDash(lh.ppg)}/${zbDash(lh.ppo)}`,
                               r:`${zbDash(rh?.ppg)}/${zbDash(rh?.ppo)}`,            lRaw:lh.ppg,     rRaw:rh?.ppg },
    { label:'Penalty Min',     l:zbFmtPim(lh.pims),       r:zbFmtPim(rh?.pims),      lRaw:lh.pims,    rRaw:rh?.pims, lowBetter:true },
  ];

  const statRows = statDefs.map(s => {
    const ln = s.lRaw != null ? +s.lRaw : NaN;
    const rn = s.rRaw != null ? +s.rRaw : NaN;
    const lBetter = !isNaN(ln) && !isNaN(rn) && (s.lowBetter ? ln < rn : ln > rn);
    const rBetter = !isNaN(ln) && !isNaN(rn) && (s.lowBetter ? rn < ln : rn > ln);
    const barPct  = (!isNaN(ln) && !isNaN(rn) && (ln+rn)>0) ? Math.round(ln/(ln+rn)*100) : 50;
    const lValStyle = lBetter ? `color:${lColor};font-weight:700` : '';
    const rValStyle = rBetter ? `color:${rColor};font-weight:700` : '';
    return `
      <div class="zb-cmp-row">
        <span class="zb-cmp-val" style="${lValStyle}">${s.l}</span>
        <div class="zb-cmp-center">
          <div class="zb-cmp-bar">
            <div class="zb-cmp-bar-l" style="width:${barPct}%;background:${lColor}"></div>
            <div class="zb-cmp-bar-r" style="width:${100-barPct}%;background:${rColor}"></div>
          </div>
          <span class="zb-cmp-label">${s.label}</span>
        </div>
        <span class="zb-cmp-val zb-cmp-val-r" style="${rValStyle}">${s.r}</span>
      </div>`;
  }).join('');

  return `
    <div class="zb-game-card">
      <div class="zb-banner">

        <div class="zb-banner-side" style="${lWin?`background:linear-gradient(90deg,${lColor}22 0%,transparent 100%)`:''}">
          <div class="zb-banner-logo">${lLogo}</div>
          <div class="zb-banner-info">
            <div class="zb-banner-code" style="${lWin?`color:${lColor}`:''}">${lTeam}</div>
            <div class="zb-banner-mgr">${lMgr?.name||''}</div>
            <div class="zb-banner-rec">${lRec}</div>
          </div>
        </div>

        <div class="zb-banner-center">
          <div class="zb-banner-scores">
            <span class="zb-banner-score" style="${lWin?`color:${lColor};text-shadow:0 0 20px ${lColor}55`:'color:rgba(255,255,255,.28)'}">${lScore}</span>
            <div class="zb-banner-final-wrap">
              <span class="zb-banner-final">FINAL${isOt?' · OT':''}${isDisc?' · <span class="zb-disc-badge">DISC</span>':''}</span>
              <span class="zb-banner-date">${dispDate}</span>
            </div>
            <span class="zb-banner-score" style="${rWin?`color:${rColor};text-shadow:0 0 20px ${rColor}55`:'color:rgba(255,255,255,.28)'}">${rScore}</span>
          </div>
        </div>

        <div class="zb-banner-side zb-banner-side-r" style="${rWin?`background:linear-gradient(270deg,${rColor}22 0%,transparent 100%)`:''}">
          <div class="zb-banner-info zb-banner-info-r">
            <div class="zb-banner-code" style="${rWin?`color:${rColor}`:''}">${rTeam}</div>
            <div class="zb-banner-mgr">${rMgr?.name||''}</div>
            <div class="zb-banner-rec">${rRec}</div>
          </div>
          <div class="zb-banner-logo">${rLogo}</div>
        </div>

      </div>
      <div class="zb-donuts">
        ${zbDonut(lh.shts, rh?.shts, 'Shots',    lColor, rColor)}
        ${zbDonut(lh.toa,  rh?.toa,  'TOA',      lColor, rColor)}
        ${zbDonut(lh.fo,   rh?.fo,   'Faceoffs', lColor, rColor)}
      </div>
      <div class="zb-compare">${statRows}</div>
    </div>`;
}

/**
 * Fetch + cache all tagged managers' Zamboni histories.
 * Returns { tagMap, gameMap, mgrRecord } or null on failure.
 *
 * Three cache layers (fastest → slowest):
 *  1. In-memory  (_zbCache)          — instant, lost on page reload
 *  2. sessionStorage (_ZB_SS_KEY)    — survives section navigation, cleared on tab close
 *  3. Zamboni API via Flask proxy    — one request per tagged manager, all parallel
 */
async function getZamboniData() {
  // ── Layer 1: in-memory ─────────────────────────────────────────────────────
  if (_zbCache && Date.now() - _zbCacheAt < _ZB_TTL) return _zbCache;

  // ── Layer 2: sessionStorage ────────────────────────────────────────────────
  try {
    const raw = sessionStorage.getItem(_ZB_SS_KEY);
    if (raw) {
      const stored = JSON.parse(raw);
      if (stored?.at && Date.now() - stored.at < _ZB_TTL) {
        // Rehydrate Map from serialized array
        _zbCache   = { tagMap: stored.tagMap, gameMap: new Map(stored.gameMapArr), mgrRecord: stored.mgrRecord };
        _zbCacheAt = stored.at;
        return _zbCache;
      }
    }
  } catch { /* sessionStorage unavailable or corrupt — fall through */ }

  // ── Layer 3: fetch from API ────────────────────────────────────────────────
  const tagMap = {};
  state.managers.forEach(m => { if (m.zamboniTag) tagMap[m.zamboniTag.toLowerCase()] = m; });
  const tags = Object.keys(tagMap);
  if (!tags.length) return null;

  const results = await Promise.all(tags.map(tag => fetchZamboniData(`player/${tag}`)));

  // Build game_id → { sides: {tag: histEntry}, created_at } map
  const gameMap = new Map();
  results.forEach((res, i) => {
    if (!res?.history) return;
    const myTag = tags[i];
    const arr = [...(res.history.vs||[]), ...(res.history.so||[])];
    arr.forEach(h => {
      const oppTag = (h.opponent||'').toLowerCase();
      if (!tagMap[oppTag]) return;
      if (!gameMap.has(h.game_id)) gameMap.set(h.game_id, { sides:{}, created_at:'' });
      const entry = gameMap.get(h.game_id);
      entry.sides[myTag] = h;
      if (h.created_at) entry.created_at = h.created_at;
    });
  });

  // Per-manager season record from full history
  const mgrRecord = {};
  results.forEach((res, i) => {
    const myTag = tags[i];
    const arr = [...(res?.history?.vs||[]), ...(res?.history?.so||[])];
    let w=0, l=0, otl=0;
    arr.forEach(h => { if (h.wins) w++; else if (h.otl) otl++; else if (h.loss) l++; });
    mgrRecord[myTag] = `${w}-${l}${otl?'-'+otl:''}`;
  });

  _zbCache   = { tagMap, gameMap, mgrRecord };
  _zbCacheAt = Date.now();

  // Persist to sessionStorage so the next box score click is instant
  try {
    sessionStorage.setItem(_ZB_SS_KEY, JSON.stringify({
      at:         _zbCacheAt,
      tagMap:     Object.fromEntries(Object.entries(tagMap).map(([k,v]) => [k, { id:v.id, name:v.name, zamboniTag:v.zamboniTag }])),
      gameMapArr: [...gameMap.entries()],
      mgrRecord,
    }));
  } catch { /* storage full or unavailable — in-memory cache is still warm */ }

  return _zbCache;
}

/**
 * Silently warm the Zamboni cache in the background.
 * Call this when opening Scores or Schedule so data is ready before any click.
 * Only fires a fetch if there are tagged managers and the cache is cold.
 */
function zbWarmCache() {
  const hasTagged = state.managers?.some(m => m.zamboniTag);
  if (!hasTagged) return;
  const cacheWarm = _zbCache && Date.now() - _zbCacheAt < _ZB_TTL;
  if (cacheWarm) return;
  // Fire-and-forget — do not await, do not block rendering
  getZamboniData().catch(() => {});
}

/**
 * Show a box score modal for a league game.
 * Fetches Zamboni data and matches by manager gamertags + score.
 */
async function showGameBoxScore(g) {
  if (!g?.played) return;

  const homeMgr = state.managers.find(m => m.id === state.teamOwners[g.homeTeam]);
  const awayMgr = state.managers.find(m => m.id === state.teamOwners[g.awayTeam]);

  $('modal-box').classList.add('modal-wide');
  showModal('Box Score', '<div class="empty-state">Loading stats…</div>');

  // If game has zamboniStats stored directly, use that
  if (g.zamboniStats) {
    try {
      const stats = typeof g.zamboniStats === 'string' ? JSON.parse(g.zamboniStats) : g.zamboniStats;
      const html = zbRenderCard(stats.home, stats.away, homeMgr, awayMgr, g.homeTeam, g.awayTeam);
      const playerStatsHtml = renderPlayerStatsSection(g);
      $('modal-body').innerHTML = `<div style="margin:-18px">${html}${playerStatsHtml}</div>`;
      $('modal-title').textContent = `${g.homeTeam} vs ${g.awayTeam}`;
      return;
    } catch (err) {
      console.error('Failed to parse zamboniStats:', err);
    }
  }

  if (!homeMgr?.zamboniTag || !awayMgr?.zamboniTag) {
    // One or both managers don't have a Zamboni tag — show player stats if available
    const playerStatsHtml = renderPlayerStatsSection(g);
    const noStatsHtml = renderNoStatsSection(g);
    if (playerStatsHtml) {
      $('modal-body').innerHTML = `<div style="margin:-18px;padding:20px">${playerStatsHtml}</div>`;
      $('modal-title').textContent = `${g.homeTeam} ${g.homeScore}–${g.awayScore} ${g.awayTeam}`;
      return;
    }
    // Show "Add Stats" button even without Zamboni
    $('modal-body').innerHTML = `<div style="margin:-18px;padding:20px">${noStatsHtml}</div>`;
    $('modal-title').textContent = `${g.homeTeam} ${g.homeScore}–${g.awayScore} ${g.awayTeam}`;
    return;
  }

  const zbData = await getZamboniData();
  if (!zbData) {
    showModal('Box Score', '<div class="empty-state">Zamboni API unavailable.</div>');
    return;
  }

  const hTag = homeMgr.zamboniTag.toLowerCase();
  const aTag = awayMgr.zamboniTag.toLowerCase();
  const gameDate = g.postedAt || g.playedAt || g.date || '';

  // Find the Zamboni game with matching score, picking closest by date on ties
  let bestMatch = null, bestDiff = Infinity;
  for (const [, zbG] of zbData.gameMap) {
    const hh = zbG.sides[hTag];
    const ah = zbG.sides[aTag];
    if (!hh || !ah) continue;
    if ((hh.scor ?? 0) != g.homeScore || (ah.scor ?? 0) != g.awayScore) continue;
    const diff = gameDate && zbG.created_at
      ? Math.abs(new Date(gameDate) - new Date(zbG.created_at)) : Infinity;
    if (diff < bestDiff) { bestDiff = diff; bestMatch = { hh, ah }; }
  }

  if (!bestMatch) {
    // No Zamboni match — show player stats if available
    const playerStatsHtml = renderPlayerStatsSection(g);
    if (playerStatsHtml) {
      $('modal-body').innerHTML = `<div style="margin:-18px;padding:20px">${playerStatsHtml}</div>`;
      $('modal-title').textContent = `${g.homeTeam} ${g.homeScore}–${g.awayScore} ${g.awayTeam}`;
      return;
    }
    $('modal-box').classList.remove('modal-wide');
    showModal(`${g.homeTeam} ${g.homeScore}–${g.awayScore} ${g.awayTeam}`,
      '<div class="empty-state">No matching Zamboni game found for this score.</div>');
    return;
  }

  const html = zbRenderCard(bestMatch.hh, bestMatch.ah, homeMgr, awayMgr, g.homeTeam, g.awayTeam);
  const playerStatsHtml = renderPlayerStatsSection(g);
  $('modal-body').innerHTML = `<div style="margin:-18px">${html}${playerStatsHtml}</div>`;
  $('modal-title').textContent = `${g.homeTeam} vs ${g.awayTeam}`;
}

function renderPlayerStatsSection(game) {
  if (!game.playerStats || game.playerStats.length === 0) {
    return '';
  }
  
  const homeStats = game.playerStats.filter(p => p.teamCode === game.homeTeam);
  const awayStats = game.playerStats.filter(p => p.teamCode === game.awayTeam);
  
  const homeGoalies = homeStats.filter(p => p.position === 'G');
  const awayGoalies = awayStats.filter(p => p.position === 'G');
  const homeSkaters = homeStats.filter(p => p.position !== 'G');
  const awaySkaters = awayStats.filter(p => p.position !== 'G');
  
  const skaterRow = (ps) => {
    const player = state.players.find(p => String(p.id) === String(ps.playerId));
    const name = player?.name || ps.playerName || 'Unknown';
    const pos = player?.position || '';
    return `
      <tr>
        <td class="text-left"><strong>${name}</strong> ${pos ? `<span class="text-xs text-muted">${pos}</span>` : ''}</td>
        <td>${ps.goals || 0}</td>
        <td>${ps.assists || 0}</td>
        <td class="font-bold">${ps.points || 0}</td>
        <td>${ps.plusMinus > 0 ? '+' : ''}${ps.plusMinus || 0}</td>
        <td>${ps.pim || 0}</td>
      </tr>
    `;
  };
  
  const goalieRow = (ps) => {
    const player = state.players.find(p => String(p.id) === String(ps.playerId));
    const name = player?.name || ps.playerName || 'Unknown';
    const svp = ps.savePercentage ? (ps.savePercentage * 100).toFixed(1) : '0.0';
    const svpFormatted = `.${svp.replace('.', '').padStart(3, '0')}`;
    return `
      <tr>
        <td class="text-left"><strong>${name}</strong></td>
        <td>${ps.shotsAgainst || 0}</td>
        <td>${ps.saves || 0}</td>
        <td>${ps.goalsAgainst || 0}</td>
        <td class="font-bold">${svpFormatted}</td>
        <td>${ps.shutout ? '✓' : ''}</td>
      </tr>
    `;
  };
  
  const goalieTable = (goalies, teamName) => {
    if (!goalies || goalies.length === 0) return '';
    
    return `
      <div class="player-stats-section mb-12">
        <h4 class="player-stats-header">${teamName} Goalie</h4>
        <div class="table-wrap">
          <table class="player-stats-table">
            <thead>
              <tr>
                <th class="text-left">Goalie</th>
                <th>SA</th>
                <th>SV</th>
                <th>GA</th>
                <th>SV%</th>
                <th>SO</th>
              </tr>
            </thead>
            <tbody>
              ${goalies.map(goalieRow).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  };
  
  const skaterTable = (skaters, teamName) => {
    if (!skaters || skaters.length === 0) return '';
    
    // Sort by points descending
    const sorted = [...skaters].sort((a, b) => (b.points || 0) - (a.points || 0));
    
    return `
      <div class="player-stats-section">
        <h4 class="player-stats-header">${teamName} Skaters</h4>
        <div class="table-wrap">
          <table class="player-stats-table">
            <thead>
              <tr>
                <th class="text-left">Player</th>
                <th>G</th>
                <th>A</th>
                <th>PTS</th>
                <th>+/-</th>
                <th>PIM</th>
              </tr>
            </thead>
            <tbody>
              ${sorted.map(skaterRow).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  };
  
  const homeGoalieTable = goalieTable(homeGoalies, game.homeTeam);
  const awayGoalieTable = goalieTable(awayGoalies, game.awayTeam);
  const homeSkaterTable = skaterTable(homeSkaters, game.homeTeam);
  const awaySkaterTable = skaterTable(awaySkaters, game.awayTeam);
  
  if (!homeGoalieTable && !awayGoalieTable && !homeSkaterTable && !awaySkaterTable) return '';
  
  const sourceLabel = game.statsSource === 'manual' ? 'Manually Entered' : 
                      game.statsSource === 'ocr_full' ? 'OCR Extracted (Full)' :
                      game.statsSource === 'ocr_goals_only' ? 'OCR Extracted (Goals Only)' : '';
  
  return `
    <div class="player-stats-container">
      <div class="player-stats-title">
        <h3>Player Statistics</h3>
        <div style="display:flex;gap:8px;align-items:center">
          ${sourceLabel ? `<span class="player-stats-source">${sourceLabel}</span>` : ''}
          <button class="btn btn-xs btn-secondary" onclick="openEditStatsModal('${game.id}')">✏️ Edit Stats</button>
        </div>
      </div>
      <div class="player-stats-grid">
        <div>
          ${homeGoalieTable}
          ${homeSkaterTable}
        </div>
        <div>
          ${awayGoalieTable}
          ${awaySkaterTable}
        </div>
      </div>
    </div>
  `;
}

function renderNoStatsSection(game) {
  if (!FEATURE_FLAGS.ENABLE_MANUAL_STATS) {
    return ''; // Don't show anything if stats are disabled
  }
  
  return `
    <div class="player-stats-container">
      <div class="player-stats-title">
        <h3>Player Statistics</h3>
      </div>
      <div class="empty-state" style="padding:40px 20px">
        <p class="text-dim">No player stats recorded for this game</p>
        <button class="btn btn-primary btn-sm mt-12" onclick="openEditStatsModal('${game.id}')">Add Player Stats</button>
      </div>
    </div>
  `;
}

async function openEditStatsModal(gameId) {
  const game = state.games.find(g => g.id === gameId);
  if (!game || !game.played) {
    toast('Game not found or not played yet', 'error');
    return;
  }
  
  hideModal(); // Close the box score modal
  
  // Wait a bit for modal to close
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Open the player stats modal with existing stats pre-filled
  openPlayerStatsEditModal(game);
}

function openPlayerStatsEditModal(game) {
  const homeRoster = state.players.filter(p => p.teamCode === game.homeTeam);
  const awayRoster = state.players.filter(p => p.teamCode === game.awayTeam);
  
  const homeGoalies = homeRoster.filter(p => p.position === 'G');
  const awayGoalies = awayRoster.filter(p => p.position === 'G');
  const homeSkaters = homeRoster.filter(p => p.position !== 'G');
  const awaySkaters = awayRoster.filter(p => p.position !== 'G');
  
  // Get existing stats
  const existingStats = game.playerStats || [];
  
  const skaterRow = (p, team) => {
    const existing = existingStats.find(s => String(s.playerId) === String(p.id) && s.position !== 'G');
    return `
    <tr data-player-id="${p.id}" data-team="${team}" data-position="skater">
      <td class="text-left"><strong>${p.name}</strong> <span class="text-xs text-muted">${p.position || ''}</span></td>
      <td><input type="number" class="stat-input stat-g" min="0" max="9" value="${existing?.goals || 0}" inputmode="numeric"></td>
      <td><input type="number" class="stat-input stat-a" min="0" max="9" value="${existing?.assists || 0}" inputmode="numeric"></td>
      <td><input type="number" class="stat-input stat-pm" min="-9" max="9" value="${existing?.plusMinus || 0}" inputmode="numeric"></td>
      <td><input type="number" class="stat-input stat-pim" min="0" max="99" value="${existing?.pim || 0}" inputmode="numeric"></td>
    </tr>
  `;
  };
  
  const goalieSelect = (goalies, team, opponentScore) => {
    if (!goalies || goalies.length === 0) {
      return '<tr><td colspan="6" class="text-dim text-center">No goalies on roster</td></tr>';
    }
    
    const existing = existingStats.find(s => s.teamCode === team && s.position === 'G');
    const selectedId = existing?.playerId || '';
    
    return `
      <tr data-team="${team}" data-position="goalie" ${selectedId ? `data-player-id="${selectedId}"` : ''}>
        <td class="text-left">
          <select class="goalie-select" data-team="${team}">
            <option value="">— Select Goalie —</option>
            ${goalies.map(g => `<option value="${g.id}" ${String(g.id) === String(selectedId) ? 'selected' : ''}>${g.name}</option>`).join('')}
          </select>
        </td>
        <td><input type="number" class="stat-input stat-sa" min="0" max="99" value="${existing?.shotsAgainst || 0}" inputmode="numeric" ${selectedId ? '' : 'disabled'}></td>
        <td><input type="number" class="stat-input stat-sv" min="0" max="99" value="${existing?.saves || 0}" inputmode="numeric" ${selectedId ? '' : 'disabled'}></td>
        <td><input type="number" class="stat-input stat-ga" min="0" max="99" value="${existing?.goalsAgainst || opponentScore}" inputmode="numeric" ${selectedId ? '' : 'disabled'}></td>
        <td class="stat-svp">${existing && existing.shotsAgainst > 0 ? `.${(existing.savePercentage * 100).toFixed(1).replace('.', '').padStart(3, '0')}` : '—'}</td>
        <td><label class="stat-so-check"><input type="checkbox" class="stat-so" ${existing?.shutout ? 'checked' : ''} ${selectedId ? '' : 'disabled'}> SO</label></td>
      </tr>
    `;
  };
  
  showModal(`Edit Player Stats — ${game.homeTeam} ${game.homeScore}-${game.awayScore} ${game.awayTeam}`, `
    <div class="portal-stats-manual-section">
      <p class="text-xs text-muted mb-8">Update player stats for this game</p>
      
      <!-- HOME TEAM -->
      <h4 class="text-sm font-bold mb-4 mt-16">${game.homeTeam} Goalies</h4>
      <div class="table-wrap mb-12">
        <table class="portal-stats-table">
          <thead>
            <tr>
              <th class="text-left">Goalie</th>
              <th>SA</th>
              <th>SV</th>
              <th>GA</th>
              <th>SV%</th>
              <th>SO</th>
            </tr>
          </thead>
          <tbody id="home-goalies-body">
            ${goalieSelect(homeGoalies, game.homeTeam, game.awayScore)}
          </tbody>
        </table>
      </div>
      
      <h4 class="text-sm font-bold mb-4">${game.homeTeam} Skaters</h4>
      <div class="table-wrap mb-12" style="max-height:200px;overflow-y:auto">
        <table class="portal-stats-table">
          <thead>
            <tr>
              <th class="text-left">Player</th>
              <th>G</th>
              <th>A</th>
              <th>+/-</th>
              <th>PIM</th>
            </tr>
          </thead>
          <tbody>
            ${homeSkaters.map(p => skaterRow(p, game.homeTeam)).join('')}
          </tbody>
        </table>
      </div>
      
      <!-- AWAY TEAM -->
      <h4 class="text-sm font-bold mb-4 mt-16">${game.awayTeam} Goalies</h4>
      <div class="table-wrap mb-12">
        <table class="portal-stats-table">
          <thead>
            <tr>
              <th class="text-left">Goalie</th>
              <th>SA</th>
              <th>SV</th>
              <th>GA</th>
              <th>SV%</th>
              <th>SO</th>
            </tr>
          </thead>
          <tbody id="away-goalies-body">
            ${goalieSelect(awayGoalies, game.awayTeam, game.homeScore)}
          </tbody>
        </table>
      </div>
      
      <h4 class="text-sm font-bold mb-4">${game.awayTeam} Skaters</h4>
      <div class="table-wrap mb-12" style="max-height:200px;overflow-y:auto">
        <table class="portal-stats-table">
          <thead>
            <tr>
              <th class="text-left">Player</th>
              <th>G</th>
              <th>A</th>
              <th>+/-</th>
              <th>PIM</th>
            </tr>
          </thead>
          <tbody>
            ${awaySkaters.map(p => skaterRow(p, game.awayTeam)).join('')}
          </tbody>
        </table>
      </div>
    </div>
    
    <button id="modal-ok" class="btn btn-primary btn-block mt-12">Save Stats</button>
    <button id="modal-cancel" class="btn btn-ghost btn-block mt-8" type="button">Cancel</button>
  `, async () => {
    const playerStats = collectPlayerStats();
    
    // Validate stats
    const validation = validatePlayerStats(playerStats, game.homeTeam, game.awayTeam, game.homeScore, game.awayScore);
    if (!validation.valid) {
      toast(validation.error, 'error');
      return;
    }
    
    const btn = $('modal-ok');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving…';
    }
    
    try {
      await updateGameStats(game.id, playerStats);
      hideModal();
      toast('Stats updated successfully', 'success');
      
      // Reload state and re-render
      state = await loadState();
      renderSection(currentSection);
    } catch (err) {
      toast(err.message || 'Failed to update stats', 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Save Stats';
      }
    }
  });
  
  // Enable goalie stats inputs when goalie is selected
  document.querySelectorAll('.goalie-select').forEach(select => {
    const row = select.closest('tr');
    const inputs = row.querySelectorAll('.stat-input, .stat-so');
    
    select.addEventListener('change', () => {
      const selected = select.value;
      inputs.forEach(input => {
        input.disabled = !selected;
      });
      
      if (selected) {
        row.dataset.playerId = selected;
      } else {
        delete row.dataset.playerId;
      }
    });
  });
  
  // Auto-calculate save percentage
  document.querySelectorAll('[data-position="goalie"]').forEach(row => {
    const saInput = row.querySelector('.stat-sa');
    const svInput = row.querySelector('.stat-sv');
    const svpCell = row.querySelector('.stat-svp');
    
    const updateSvp = () => {
      const sa = parseInt(saInput?.value, 10) || 0;
      const sv = parseInt(svInput?.value, 10) || 0;
      if (sa > 0) {
        const svp = (sv / sa * 100).toFixed(1);
        svpCell.textContent = `.${svp.replace('.', '').padStart(3, '0')}`;
      } else {
        svpCell.textContent = '—';
      }
    };
    
    saInput?.addEventListener('input', updateSvp);
    svInput?.addEventListener('input', updateSvp);
  });
  
  $('modal-cancel')?.addEventListener('click', () => hideModal());
}

async function updateGameStats(gameId, playerStats) {
  const r = await fetch('/api/admin/game-stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gameId,
      playerStats,
      statsSource: 'manual'
    })
  });
  
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to update stats');
  }
  
  return await r.json();
}

async function fetchNHLRosters({ silent = false } = {}) {
  const PROXY = 'https://corsproxy.io/?';
  const btn = $('fetch-nhl-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching…'; }
  if (!silent) toast('Fetching NHL rosters…', 'info');

  const teams = NHL_TEAMS.filter(t => !['UTI'].includes(t.code));
  const allPlayers = [];
  const errors = [];

  await Promise.all(teams.map(async team => {
    const apiCode = NHL_API_CODE_MAP[team.code] || team.code;
    try {
      const r = await fetch(PROXY + `https://api-web.nhle.com/v1/roster/${apiCode}/current`);
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      [...(d.forwards||[]), ...(d.defensemen||[]), ...(d.goalies||[])].forEach(p => {
        allPlayers.push({
          id: p.id,
          name: `${p.firstName.default} ${p.lastName.default}`,
          teamCode: '',      // unassigned — draft/admin handles team placement
          position: p.positionCode || '',
          headshot: p.headshot || '',
          number: p.sweaterNumber || 0,
        });
      });
    } catch(e) { errors.push(team.code); }
  }));

  if (allPlayers.length) {
    // Preserve existing OVR/PLT and team assignment when refreshing
    allPlayers.forEach(p => {
      const existing = state.players.find(e => e.id === p.id);
      if (existing) {
        p.ovr = existing.ovr;
        p.plt = existing.plt;
        if (existing.teamCode) p.teamCode = existing.teamCode;
      }
    });
    state.players = allPlayers;
    // Re-apply trade history so trades always win over API data
    applyTradeHistory();
    saveState();
    if (!silent) toast(`${allPlayers.length} players loaded`, 'success');
    if (currentSection === 'settings') renderSettings();
    else renderDashboard();
  } else {
    if (!silent) toast('Could not reach NHL.com — check connection', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Retry Fetch'; }
  }
  if (errors.length && !silent) toast(`Some teams failed: ${errors.join(', ')}`, 'warn');
}

// ================================================================
// SEASON MANAGEMENT
// ================================================================
function getSeasonChampion() {
  if (!state.playoffs) return null;
  const lastRound = state.playoffs.rounds[state.playoffs.rounds.length - 1];
  if (!lastRound) return null;
  const finalSeries = lastRound.series[0];
  return finalSeries?.winner || null;
}

function saveSeasonSnapshot() {
  if (!state.currentSeason) state.currentSeason = 1;
  if (!state.seasons) state.seasons = [];
  const existing = state.seasons.findIndex(s => s.number === state.currentSeason);
  const snapshot = {
    id:          existing >= 0 ? state.seasons[existing].id : uid(),
    number:      state.currentSeason,
    name:        state.league.season || `Season ${state.currentSeason}`,
    leagueName:  state.league.name,
    savedAt:     new Date().toISOString(),
    champion:    getSeasonChampion(),
    standings:   calcStandings(),
    games:       JSON.parse(JSON.stringify(state.games)),
    liveDraft:   JSON.parse(JSON.stringify(state.liveDraft)),
    playoffs:    state.playoffs ? JSON.parse(JSON.stringify(state.playoffs)) : null,
    trades:      JSON.parse(JSON.stringify(state.trades)),
  };
  if (existing >= 0) state.seasons[existing] = snapshot;
  else state.seasons.push(snapshot);
  saveState();
  return snapshot;
}

function startNewSeason() {
  const seasonNum = state.currentSeason || 1;
  if (!confirm(`Save Season ${seasonNum} and start Season ${seasonNum + 1}? This will archive the current season and clear all games, draft, and playoff data.`)) return;
  saveSeasonSnapshot();
  // Reset volatile season data, keep league structure + players
  state.games       = [];
  state.liveDraft   = { active: false, rounds: 21, order: [], picks: [] };
  state.playoffs    = null;
  state.trades      = [];
  state.currentSeason = seasonNum + 1;
  state.league.season = `Season ${state.currentSeason}`;
  saveState();
  renderSection('dashboard');
  navigate('dashboard');
  toast(`Season ${seasonNum} archived. Season ${state.currentSeason} started!`, 'success');
}

function loadSeasonSnapshot(seasonId) {
  const s = state.seasons.find(ss => ss.id === seasonId);
  if (!s) return;
  if (!confirm(`Load Season ${s.number} (${s.name}) as the current active season? This will replace your current games, draft, and playoff data. Managers and players are kept.`)) return;
  // Preserve league structure
  state.games       = JSON.parse(JSON.stringify(s.games || []));
  state.liveDraft   = JSON.parse(JSON.stringify(s.liveDraft || { active: false, rounds: 21, order: [], picks: [] }));
  state.playoffs    = s.playoffs ? JSON.parse(JSON.stringify(s.playoffs)) : null;
  state.trades      = JSON.parse(JSON.stringify(s.trades || []));
  state.currentSeason = s.number;
  state.league.season = s.name;
  saveState();
  renderSection('dashboard');
  navigate('dashboard');
  toast(`Season ${s.number} loaded as current`, 'success');
}

function viewSeasonModal(seasonId) {
  const s = state.seasons.find(ss => ss.id === seasonId);
  if (!s) return;
  const champ = s.champion ? `<div class="champion-banner" style="margin-bottom:16px">🏆 Champion: <strong>${teamBadge(s.champion)}</strong> ${teamOwnerName(s.champion)}</div>` : '';
  const top8 = (s.standings || []).slice(0, 8).map((t, i) => `
    <tr class="${i===0?'leader':''}">
      <td class="num">${i+1}</td>
      <td><span style="display:inline-flex;align-items:center;gap:6px">${teamLogoLg(t.teamCode,32)}<strong>${t.teamCode}</strong></span></td>
      <td class="text-muted text-sm">${teamOwnerName(t.teamCode)}</td>
      <td class="num">${t.gp}</td><td class="num">${t.w}</td><td class="num">${t.l}</td><td class="num pts-col">${t.pts}</td>
      <td class="num">${t.gf??''}</td><td class="num">${t.ga??''}</td>
      <td class="num" style="color:${(t.gf-t.ga)>0?'var(--success)':(t.gf-t.ga)<0?'var(--danger)':'inherit'}">${t.gf!=null?(t.gf-t.ga>0?'+':'')+(t.gf-t.ga):''}</td>
    </tr>`).join('');
  const gp = (s.games||[]).filter(g=>g.played&&!g.playoff).length;
  const trades = (s.trades||[]).length;
  const picks = (s.liveDraft?.picks||[]).length;
  showModal(`${s.name}`, `
    ${champ}
    <div class="dash-grid" style="margin-bottom:16px">
      <div class="stat-card"><div class="stat-value">${gp}</div><div class="stat-label">Games</div></div>
      <div class="stat-card"><div class="stat-value">${picks}</div><div class="stat-label">Draft Picks</div></div>
      <div class="stat-card"><div class="stat-value">${trades}</div><div class="stat-label">Trades</div></div>
      <div class="stat-card"><div class="stat-value">${fmtDate(s.savedAt)}</div><div class="stat-label">Saved</div></div>
    </div>
    <div class="table-wrap">
      <table class="standings-table">
        <thead><tr><th>#</th><th>Team</th><th>Manager</th><th>GP</th><th>W</th><th>L</th><th class="pts-col">PTS</th><th>GF</th><th>GA</th><th>DIFF</th></tr></thead>
        <tbody>${top8}</tbody>
      </table>
    </div>
  `);
}

// Admin pending trade review moved to admin-pending.js

function timeSince(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

function renderSettings() {
  const el_ = $('section-settings');
  checkPendingTrades();
  const sysData = normalizeSysDataFile(state.sysDataFile);
  const unassignedCount = NHL_TEAMS
    .filter(t => t.code !== 'UTI' && !state.teamOwners[t.code]).length;

  // ── MENU ──────────────────────────────────────────────────────
  if (!_settingsSection) {
    
    const menuItems = [
      { id:'managers', icon:'👤', title:'Managers',
        sub:`${state.managers.length} managers · ${unassignedCount} unassigned` },
      { id:'league', icon:'🏒', title:'League',
        sub:`${state.league.name||'NHL Legacy League'} · Season ${state.league.season||'—'}` },
      { id:'seasons', icon:'📅', title:'Seasons',
        sub:`Season ${state.currentSeason||1} · ${(state.seasons||[]).length} archived` },
      ...(isAdmin ? [
        { id:'pending',  icon:'🔄', title:'Pending Trades', sub:'Review and approve trade proposals', badge: true },
        { id:'discord',  icon:'💬', title:'Discord',        sub:'Bot control · channel settings' },
        { id:'playoffs', icon:'🏆', title:'Playoff Format', sub:`${(state.playoffFormat||[]).length} rounds configured` },
        { id:'sysdata',  icon:'💾', title:'SYS-DATA',       sub: sysData ? `${sysData.name} · ${formatBytes(sysData.size)}` : 'No file uploaded' },
        { id:'rules',    icon:'📋', title:'League Rules',   sub:'Edit the rules page content' },
        { id:'roster',   icon:'🗂️', title:'NHL Roster',     sub: state.players.length ? `${state.players.length} players loaded` : 'Not loaded' },
        { id:'data',     icon:'📦', title:'Data',           sub:'Export · Import · Migrate · Reset' },
      ] : []),
    ];
    el_.innerHTML = `
      <div class="page-header"><h2>Settings</h2></div>
      <div class="settings-menu-grid">
        ${menuItems.map(m => `
          <button class="settings-menu-card" data-sect="${m.id}">
            <span class="settings-menu-icon">${m.icon}</span>
            <div class="settings-menu-text">
              <div class="settings-menu-title">
                ${m.title}
                ${m.badge ? '<span class="settings-badge" style="display:none;margin-left:8px;background:#e74c3c;color:#fff;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">0</span>' : ''}
              </div>
              <div class="settings-menu-sub">${m.sub}</div>
            </div>
            <span class="settings-menu-arrow">›</span>
          </button>`).join('')}
      </div>`;
    document.querySelectorAll('.settings-menu-card').forEach(btn =>
      btn.addEventListener('click', () => { _settingsSection = btn.dataset.sect; renderSettings(); })
    );
    return;
  }

  // ── SECTION TITLES ────────────────────────────────────────────
  const TITLES = {
    managers:'Managers', league:'League', seasons:'Seasons', pending:'Pending Trades',
    discord:'Discord', playoffs:'Playoff Format', sysdata:'SYS-DATA',
    rules:'League Rules', roster:'NHL Roster Data', data:'Data',
  };

  // ── BUILD SECTION HTML ────────────────────────────────────────
  let _html = '';

  switch (_settingsSection) {

    case 'managers': _html = `
      <div class="card mgr-card-fullwidth">
        <div class="mgr-topbar">
          <div class="mgr-topbar-left">
            <span class="card-title" style="margin-bottom:0">Managers</span>
            <span class="mgr-topbar-meta">${state.managers.length} managers · ${unassignedCount} unassigned</span>
          </div>
          <div class="mgr-topbar-right">
            <input class="mgr-search-input" id="mgr-search" placeholder="Search name or team…" autocomplete="off">
            <select class="mgr-filter-sel" id="mgr-filter-status">
              <option value="">All</option>
              <option value="no-team">No team</option>
              <option value="no-discord">No Discord</option>
              <option value="no-zamboni">No Zamboni</option>
            </select>
          </div>
        </div>
        <div class="mgr-split">
          <div class="mgr-list-col" id="mgr-list-col">
            ${state.managers.map(m => {
              const team = getManagerTeam(m.id);
              return `
              <button class="mgr-list-item" data-mid="${m.id}" aria-pressed="false">
                <span class="manager-dot" style="background:${m.color||'#555'};display:inline-block"></span>
                <span class="mgr-list-name">${m.name.replace(/</g,'&lt;')}</span>
                <span class="mgr-list-team">${team||''}</span>
                <span class="mgr-status-pip ${!!team?'pip-ok':'pip-off'}" title="${!!team?'Team assigned':'No team'}">T</span>
                <span class="mgr-status-pip ${!!(m.discordId||m.discordUsername)?'pip-ok':'pip-off'}" title="${!!(m.discordId||m.discordUsername)?'Discord linked':'No Discord'}">D</span>
                <span class="mgr-status-pip ${!!m.zamboniTag?'pip-ok':'pip-off'}" title="${!!m.zamboniTag?'Zamboni set':'No Zamboni'}">Z</span>
              </button>`;
            }).join('')}
          </div>
          <div class="mgr-detail-col" id="mgr-detail-col">
            <div class="mgr-detail-empty" id="mgr-detail-empty">
              <span class="mgr-detail-empty-icon">👤</span>
              <p>Select a manager to ${isAdmin?'view or edit':'view'}</p>
            </div>
            <div class="mgr-detail-form hidden" id="mgr-detail-form">
              <div class="mgr-detail-header">
                <span class="manager-dot mgr-detail-dot" id="mgr-detail-dot" style="display:inline-block"></span>
                <span class="mgr-detail-title" id="mgr-detail-title"></span>
                ${isAdmin ? `<button class="btn btn-ghost btn-sm" id="mgr-detail-del" style="margin-left:auto" data-mid="">✕ Remove</button>` : ''}
              </div>
              <div class="mgr-detail-fields">
                <div class="mgr-detail-group">
                  <label class="mgr-detail-label">Display Name</label>
                  ${isAdmin ? `<input class="mgr-detail-input" id="mgr-d-name" placeholder="Name">` : `<span id="mgr-d-name-ro" style="font-size:.85rem;font-weight:600"></span>`}
                </div>
                ${isAdmin ? `
                <div class="mgr-detail-group">
                  <label class="mgr-detail-label">Color</label>
                  <div class="mgr-color-row">
                    <input type="color" class="mgr-color-picker" id="mgr-d-color">
                    <div class="mgr-color-swatches">
                      ${MANAGER_COLORS.map(c=>`<button class="mgr-swatch" style="background:${c}" data-color="${c}" type="button"></button>`).join('')}
                    </div>
                  </div>
                </div>` : ''}
                <div class="mgr-detail-row-2col">
                  <div class="mgr-detail-group">
                    <label class="mgr-detail-label">Primary Team <span class="mgr-pip-inline pip-off" id="mgr-pip-team">T</span></label>
                    ${isAdmin
                      ? `<select class="mgr-detail-sel" id="mgr-d-team"><option value="">— None —</option>${NHL_TEAMS.filter(t=>t.code!=='UTI').map(t=>`<option value="${t.code}">${t.code}</option>`).join('')}</select>`
                      : `<span class="text-sm" id="mgr-d-team-ro">—</span>`}
                  </div>
                  <div class="mgr-detail-group">
                    <label class="mgr-detail-label">Co-Mgr of</label>
                    ${isAdmin
                      ? `<select class="mgr-detail-sel" id="mgr-d-coteam"><option value="">— None —</option>${NHL_TEAMS.filter(t=>t.code!=='UTI').map(t=>`<option value="${t.code}">${t.code}</option>`).join('')}</select>`
                      : `<span class="text-sm" id="mgr-d-coteam-ro">—</span>`}
                  </div>
                </div>
                <div class="mgr-detail-section-head">Discord <span class="mgr-pip-inline pip-off" id="mgr-pip-disc">D</span></div>
                <div class="mgr-detail-row-2col">
                  <div class="mgr-detail-group">
                    <label class="mgr-detail-label">Discord ID <span class="mgr-field-hint">18-digit snowflake</span></label>
                    ${isAdmin ? `<input class="mgr-detail-input" id="mgr-d-discordId" placeholder="345570333052370956">` : `<span class="text-xs" id="mgr-d-discordId-ro">—</span>`}
                  </div>
                  <div class="mgr-detail-group">
                    <label class="mgr-detail-label">Username <span class="mgr-field-hint">future: OAuth</span></label>
                    ${isAdmin ? `<input class="mgr-detail-input" id="mgr-d-discordUsername" placeholder="@tino45">` : `<span class="text-xs" id="mgr-d-discordUsername-ro">—</span>`}
                  </div>
                </div>
                <div class="mgr-detail-section-head">Zamboni <span class="mgr-pip-inline pip-off" id="mgr-pip-zamb">Z</span></div>
                <div class="mgr-detail-group">
                  <label class="mgr-detail-label">RPCN Account</label>
                  ${isAdmin
                    ? `<div class="zamboni-wrap"><input type="text" class="mgr-detail-input" id="mgr-d-zamboniTag" placeholder="RPCN Account" autocomplete="off"><div class="zamboni-drop" id="zdrop-detail"></div></div>`
                    : `<span class="text-xs" id="mgr-d-zamboniTag-ro">—</span>`}
                </div>
              </div>
              ${isAdmin ? `
              <div class="mgr-detail-actions">
                <button class="btn btn-primary btn-sm" id="mgr-detail-save">Save Changes</button>
                <span class="mgr-save-feedback hidden" id="mgr-save-feedback">✓ Saved</span>
              </div>` : ''}
            </div>
          </div>
        </div>
        ${isAdmin ? `
        <div class="mgr-footer-row">
          <input id="new-manager-name" placeholder="New manager name…">
          <button class="btn btn-ghost btn-sm" id="add-manager-btn">+ Add</button>
        </div>` : ''}
      </div>`; break;

    case 'pending': _html = `
      <div class="card">
        <div class="card-title">Pending Trade Proposals</div>
        <div id="pending-trades-list">Loading...</div>
      </div>`; break;

    case 'league': _html = `
      <div class="card">
        <div class="form-row"><label>League Name</label><input id="set-league-name" value="${state.league.name}" ${isAdmin?'':'readonly'}></div>
        <div class="form-row"><label>Season</label><input id="set-season" value="${state.league.season||''}" placeholder="e.g. 2024-25" ${isAdmin?'':'readonly'}></div>
        ${isAdmin ? `
          <div class="form-row">
            <label style="display:flex;align-items:center;gap:8px">
              <input type="checkbox" id="set-draft-enabled" ${state.league.draftEnabled?'checked':''}>
              <span>Enable Draft (show Draft nav button)</span>
            </label>
          </div>
          <div class="form-row"><label>Admin Password</label><input type="password" id="set-admin-pw" placeholder="Set new password"></div>
          <button class="btn btn-primary" id="save-league-btn">Save</button>
          
          ${state.liveDraft?.active ? `
            <hr style="margin:24px 0;border:none;border-top:1px solid var(--border)">
            <div class="form-row">
              <label style="color:var(--danger)">⚠️ Draft Management</label>
              <p class="text-xs text-dim mb-8">Draft is currently active with ${state.liveDraft.picks?.length || 0} picks made.</p>
              <button class="btn btn-danger btn-sm" id="reset-draft-btn">Reset Draft (Clear All Picks)</button>
            </div>
          ` : ''}
        ` : ''}
      </div>`; break;

    case 'seasons': _html = `
      <div class="card">
        <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>Season History</span>
          ${isAdmin ? `
          <div class="flex gap-8">
            <button class="btn btn-primary btn-sm" id="save-season-btn">Save Season Snapshot</button>
            <button class="btn btn-accent btn-sm" id="new-season-btn">Start New Season ▶</button>
          </div>` : ''}
        </div>
        <p class="text-xs text-muted mb-12">
          Current: <strong>Season ${state.currentSeason || 1}</strong>
          ${state.league.season ? ` — ${state.league.season}` : ''}
        </p>
        ${(state.seasons||[]).length === 0 ? `
          <div class="empty-state" style="padding:20px 0">No saved seasons yet. Use <em>Save Season Snapshot</em> to archive the current season.</div>
        ` : `
          <div class="season-history-list">
            ${[...(state.seasons||[])].sort((a,b)=>b.number-a.number).map(s => {
              const champ = s.champion;
              const gp = (s.games||[]).filter(g=>g.played&&!g.playoff).length;
              return `
              <div class="season-row">
                <div class="season-row-left">
                  <div class="season-number">S${s.number}</div>
                  <div>
                    <div class="season-name">${s.name}</div>
                    <div class="season-meta">${gp} games · ${fmtDate(s.savedAt)}</div>
                  </div>
                </div>
                <div class="season-row-right">
                  ${champ ? `<div class="season-champ">🏆 ${teamBadge(champ)} <span class="text-sm text-muted">${teamOwnerName(champ)}</span></div>` : '<span class="text-dim text-sm">No champion</span>'}
                  <div class="flex gap-8">
                    <button class="btn btn-ghost btn-sm view-season-btn" data-sid="${s.id}">View</button>
                    ${isAdmin ? `<button class="btn btn-accent btn-sm load-season-btn" data-sid="${s.id}">Load</button>` : ''}
                    ${isAdmin ? `<button class="btn btn-danger btn-sm del-season-btn" data-sid="${s.id}">✕</button>` : ''}
                  </div>
                </div>
              </div>`;
            }).join('')}
          </div>
        `}
      </div>`; break;

    case 'discord': _html = isAdmin ? `
      <div class="card" id="bot-control-card">
        <div class="card-title" style="display:flex;align-items:center;gap:8px">
          🤖 Discord Bot
          <span id="bot-status-dot" style="width:8px;height:8px;border-radius:50%;background:var(--text-dim);display:inline-block"></span>
          <span id="bot-status-label" style="font-size:.72rem;color:var(--text-dim);font-weight:400">Checking…</span>
        </div>
        <p class="text-xs text-muted mb-12">Start or stop the Discord bot directly from here. No server access needed.</p>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-primary btn-sm" id="bot-start-btn">▶ Start Bot</button>
          <button class="btn btn-danger btn-sm" id="bot-stop-btn">■ Stop Bot</button>
          <button class="btn btn-ghost btn-sm" id="bot-refresh-btn" title="Refresh status">↺</button>
        </div>
        <div id="bot-log" style="margin-top:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;font-family:monospace;font-size:.68rem;color:var(--text-dim);max-height:160px;overflow-y:auto;white-space:pre-wrap;display:none"></div>
      </div>
      <div class="card" id="discord-channels-card">
        <div class="card-title">📢 Discord Channels</div>
        <p class="text-xs text-muted mb-12">
          Right-click any channel in Discord → <strong>Copy Channel ID</strong> (requires Developer Mode).
          Leave blank to disable that notification.
        </p>
        <div class="form-row">
          <label>🏒 Scores Channel ID</label>
          <input id="dc-scores" placeholder="e.g. 1363924034609217618" value="${(state.discordConfig||{}).scoresChannel||''}">
        </div>
        <div class="form-row">
          <label>🔄 Trades Channel ID</label>
          <input id="dc-trades" placeholder="e.g. 1363924034609217619" value="${(state.discordConfig||{}).tradesChannel||''}">
        </div>
        <div class="form-row">
          <label>📥 Pending / Approvals Channel ID <span class="text-dim" style="font-size:.7rem;font-weight:400">(optional — alternative to admin DMs)</span></label>
          <input id="dc-pending" placeholder="e.g. 1363924034609217620" value="${(state.discordConfig||{}).pendingChannel||''}">
        </div>
        <div class="form-row">
          <label>🔗 Signups Channel ID</label>
          <input id="dc-signups" placeholder="e.g. 1363924034609217621" value="${(state.discordConfig||{}).signupsChannel||''}">
        </div>
        <div class="form-row" style="align-items:center;gap:10px">
          <label style="margin:0">DM admins for approvals</label>
          <input type="checkbox" id="dc-admindm" ${(state.discordConfig||{}).adminDm !== false ? 'checked' : ''} style="width:auto;accent-color:var(--primary)">
          <span class="text-xs text-dim">When checked, each admin gets a DM with Approve/Reject buttons</span>
        </div>
        <button class="btn btn-primary mt-12" id="save-discord-cfg-btn">Save Discord Settings</button>
      </div>` : '<div class="empty-state">Admin access required.</div>'; break;

    case 'playoffs': _html = isAdmin ? `
      <div class="card">
        <div class="card-title">Playoff Format</div>
        <p class="text-xs text-muted mb-12">Set the series length for each playoff round. Configure before the season starts.</p>
        <div id="playoff-format-rows">
          ${(state.playoffFormat || []).map((r, i) => `
            <div class="pf-row" data-idx="${i}">
              <span class="pf-round-num">${i + 1}</span>
              <input type="text" class="pf-name-input" value="${r.name}" placeholder="Round name"
                style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:var(--chrome-bright);font-size:.82rem">
              <select class="pf-bo-select" style="padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:var(--chrome-bright);font-size:.82rem">
                ${[3,5,7].map(n => `<option value="${Math.ceil(n/2)}" ${r.winTo===Math.ceil(n/2)?'selected':''}>Bo${n}</option>`).join('')}
              </select>
              <button class="btn btn-ghost btn-sm pf-del-btn" data-idx="${i}" style="padding:4px 8px;font-size:.75rem">✕</button>
            </div>`).join('')}
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-ghost btn-sm" id="pf-add-btn">+ Add Round</button>
          <button class="btn btn-primary btn-sm" id="pf-save-btn">Save Format</button>
        </div>
      </div>` : '<div class="empty-state">Admin access required.</div>'; break;

    case 'sysdata': _html = isAdmin ? `
      <div class="card">
        <div class="card-title">Player Attributes (Recommended)</div>
        <p class="text-xs text-muted mb-12">Upload <code>player_attributes.json</code> generated from the DLL for 100% accurate attributes.</p>
        <input type="file" id="attributes-json-input" style="display:none" accept=".json">
        <button class="btn btn-primary" id="upload-attributes-btn">📤 Upload player_attributes.json</button>
        <div class="text-xs text-dim mt-8">
          Players with attributes: ${state.players.filter(p => p.attributes).length}/${state.players.length}
        </div>
      </div>
      
      <div class="card mt-12">
        <div class="card-title">SYS-DATA Distribution</div>
        <p class="text-xs text-muted mb-12">Upload the SYS-DATA file here. All league members can download it directly from the dashboard — no sharing links needed.</p>
        ${sysData ? `
          <div class="flex items-center gap-12 mb-12" style="background:rgba(74,140,200,.06);border:1px solid var(--border);border-radius:6px;padding:10px 14px">
            <div style="flex:1">
              <div class="text-sm font-bold">${sysData.name}</div>
              <div class="text-xs text-dim mt-4">${formatBytes(sysData.size)} · Uploaded ${fmtDate(sysData.uploadedAt)}</div>
            </div>
            <button class="btn btn-ghost btn-sm" id="dl-sysdata-settings-btn">⬇ Preview</button>
            <button class="btn btn-danger btn-sm" id="clear-sysdata-btn">Remove</button>
          </div>
          <div class="flex items-center gap-10 mb-12">
            <label class="text-xs text-muted" style="white-space:nowrap">Week shown on dashboard:</label>
            <input type="number" id="sysdata-week-input" min="1" max="82" placeholder="Week #"
              value="${sysData.week || ''}"
              style="width:72px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:var(--chrome-bright);font-size:.82rem;text-align:center">
            <button class="btn btn-ghost btn-sm" id="save-sysdata-week-btn">Save</button>
          </div>` : `
          <div class="flex items-center gap-10 mb-12">
            <label class="text-xs text-muted" style="white-space:nowrap">Week # for this file:</label>
            <input type="number" id="sysdata-week-input" min="1" max="82" placeholder="e.g. 14"
              style="width:72px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:var(--chrome-bright);font-size:.82rem;text-align:center">
          </div>`}
        <input type="file" id="sysdata-file-input" style="display:none" accept="*/*">
        <button class="btn btn-primary" id="upload-sysdata-btn">${sysData ? 'Replace File' : 'Upload SYS-DATA'}</button>
      </div>` : '<div class="empty-state">Admin access required.</div>'; break;

    case 'rules': _html = isAdmin ? `
      <div class="card">
        <div class="card-title">League Rules</div>
        <p class="text-xs text-muted mb-12">Use <strong>## Section Title</strong> for sections, <strong>### Sub-heading</strong> for sub-sections, <strong>**bold**</strong> for emphasis, and <strong>- item</strong> for bullet lists.</p>
        <textarea id="rules-editor" style="width:100%;height:340px;font-size:.78rem;font-family:monospace;resize:vertical">${(state.rules ?? DEFAULT_RULES).replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-primary" id="save-rules-btn">Save Rules</button>
          <button class="btn btn-ghost btn-sm" id="reset-rules-btn">Reset to Default</button>
        </div>
      </div>` : '<div class="empty-state">Admin access required.</div>'; break;

    case 'roster': _html = `
      <div class="card">
        <div class="card-title">NHL Roster Data</div>
        <div class="flex items-center gap-12" style="margin-bottom:10px">
          <span class="text-sm ${state.players.length ? 'text-success' : 'text-muted'}">
            ${state.players.length ? `✓ ${state.players.length} players loaded` : '⏳ Loading from NHL.com…'}
          </span>
          <button class="btn btn-ghost btn-sm" id="fetch-nhl-btn">Refresh Roster</button>
        </div>
        <p class="text-xs text-dim">Player data is fetched automatically from NHL.com on startup and refreshed monthly.</p>
      </div>`; break;

    case 'data': _html = `
      ${isAdmin ? `
      <div class="card">
        <div class="card-title">Server Sync</div>
        <div class="flex items-center gap-12" style="flex-wrap:wrap;margin-bottom:8px">
          <span id="api-status-badge" class="text-xs" style="color:${_apiAvailable ? 'var(--success)' : 'var(--text-muted)'}">
            ${_apiAvailable ? '✓ Connected to server' : '○ Using local storage only'}
          </span>
          <button class="btn btn-sm ${_apiAvailable ? 'btn-ghost' : 'btn-primary'}" id="migrate-server-btn">
            ${_apiAvailable ? '↑ Push to Server' : '↑ Migrate to Server'}
          </button>
        </div>
        <p class="text-xs text-dim mt-4">Pushes all local data to the SQLite backend. Required once before the Discord bot can see league data.</p>
      </div>` : ''}
      <div class="card">
        <div class="card-title">Import / Export</div>
        <div class="flex gap-8 flex-wrap">
          <button class="btn btn-secondary" id="export-btn">Export League JSON</button>
          <button class="btn btn-secondary" id="import-btn-show">Import League JSON</button>
        </div>
        <div id="import-area" class="hidden mt-12">
          <div class="flex gap-8 flex-wrap mb-8">
            <label class="btn btn-secondary" style="cursor:pointer">
              Upload JSON File
              <input type="file" id="import-file-input" accept=".json,application/json" style="display:none">
            </label>
            <span id="import-file-name" class="text-xs text-muted" style="align-self:center"></span>
          </div>
          <textarea id="import-json" placeholder="Paste JSON here, or upload a file above…" style="width:100%;height:120px;font-size:.75rem"></textarea>
          <button class="btn btn-primary mt-8" id="import-confirm-btn">Import</button>
        </div>
      </div>
      ${isAdmin ? `
      <div class="card">
        <div class="card-title">Danger Zone</div>
        <details class="advanced-settings-card mb-12">
          <summary class="advanced-settings-summary">Advanced Settings</summary>
          <div class="advanced-settings-body">
            <p class="text-xs text-muted mb-12">Danger zone actions for testing or full-league resets. Keep this away from normal day-to-day admin work.</p>
            <div class="advanced-setting-item">
              <div>
                <div style="font-weight:700">Simulate Full Season</div>
                <div class="text-xs text-muted mt-4">Generates a complete simulated season: snake draft, 10-week schedule, and playoffs. Replaces existing draft, schedule, and playoff data.</div>
              </div>
              <button class="btn btn-danger" id="simulate-season-btn">Simulate Full Season</button>
            </div>
          </div>
        </details>
        <div class="flex gap-8 flex-wrap mb-12">
          <button class="btn btn-danger" id="reset-btn">Reset League</button>
        </div>
        <div class="text-xs text-dim">Admin: <button class="btn btn-ghost btn-sm" id="admin-logout-btn">Logout</button></div>
      </div>` : ''}
    `; break;

    default: _html = '<div class="empty-state">Unknown section.</div>';
  }

  el_.innerHTML = `
    <div class="settings-section-page">
      <div class="settings-back-bar">
        <button class="settings-back-btn" id="settings-back">‹ Settings</button>
        <span class="settings-section-heading">${TITLES[_settingsSection] || _settingsSection}</span>
      </div>
      <div class="settings-section-body">${_html}</div>
    </div>`;

  $('settings-back').addEventListener('click', () => {
    _settingsSection = null;
    renderSettings();
  });

  // ── Section event handlers ─────────────────────────────────────
  switch (_settingsSection) {

    case 'managers': {
      function _mgrPip(id, ok) {
        const el = $(id);
        if (!el) return;
        el.className = `mgr-pip-inline ${ok ? 'pip-ok' : 'pip-off'}`;
      }
      function _updateMgrListItem(mid) {
        const btn = document.querySelector(`.mgr-list-item[data-mid="${CSS.escape(mid)}"]`);
        if (!btn) return;
        const mgr = state.managers.find(m => m.id === mid);
        if (!mgr) return;
        const team = getManagerTeam(mid);
        const dot  = btn.querySelector('.manager-dot');
        if (dot) dot.style.background = mgr.color || '#555';
        const nm = btn.querySelector('.mgr-list-name');
        if (nm) nm.textContent = mgr.name;
        const tm = btn.querySelector('.mgr-list-team');
        if (tm) tm.textContent = team || '';
        const pips = btn.querySelectorAll('.mgr-status-pip');
        const pc = (el, ok) => { if (el) el.className = `mgr-status-pip ${ok?'pip-ok':'pip-off'}`; };
        pc(pips[0], !!team);
        pc(pips[1], !!(mgr.discordId || mgr.discordUsername));
        pc(pips[2], !!mgr.zamboniTag);
      }
      function _openMgrDetail(mid) {
        const mgr = state.managers.find(m => m.id === mid);
        if (!mgr) return;
        document.querySelectorAll('.mgr-list-item').forEach(b =>
          b.setAttribute('aria-pressed', b.dataset.mid === mid ? 'true' : 'false')
        );
        $('mgr-detail-empty')?.classList.add('hidden');
        const form = $('mgr-detail-form');
        if (!form) return;
        form.classList.remove('hidden');
        const team   = getManagerTeam(mid);
        const coTeam = Object.entries(state.teamCoOwners||{}).find(([,m])=>m===mid)?.[0] || '';
        const dot = $('mgr-detail-dot');
        if (dot) dot.style.background = mgr.color || '#555';
        const ttl = $('mgr-detail-title');
        if (ttl) ttl.textContent = mgr.name;
        const del = $('mgr-detail-del');
        if (del) del.dataset.mid = mid;
        const set = (id, val) => { const el=$(id); if(el) { if(el.tagName==='INPUT'||el.tagName==='SELECT') el.value=val||''; else el.textContent=val||'—'; } };
        set('mgr-d-name', mgr.name);
        set('mgr-d-name-ro', mgr.name);
        if ($('mgr-d-color')) {
          $('mgr-d-color').value = mgr.color || '#CE1126';
          document.querySelectorAll('.mgr-swatch').forEach(s =>
            s.classList.toggle('swatch-active', s.dataset.color === mgr.color)
          );
        }
        set('mgr-d-team', team);
        set('mgr-d-team-ro', team);
        set('mgr-d-coteam', coTeam);
        set('mgr-d-coteam-ro', coTeam);
        set('mgr-d-discordId', mgr.discordId);
        set('mgr-d-discordId-ro', mgr.discordId ? '✓ ' + mgr.discordId : '—');
        set('mgr-d-discordUsername', mgr.discordUsername);
        set('mgr-d-discordUsername-ro', mgr.discordUsername ? '@' + mgr.discordUsername : '—');
        set('mgr-d-zamboniTag', mgr.zamboniTag);
        set('mgr-d-zamboniTag-ro', mgr.zamboniTag);
        _mgrPip('mgr-pip-team', !!team);
        _mgrPip('mgr-pip-disc', !!(mgr.discordId || mgr.discordUsername));
        _mgrPip('mgr-pip-zamb', !!mgr.zamboniTag);
        $('mgr-save-feedback')?.classList.add('hidden');
      }

      document.querySelectorAll('.mgr-list-item').forEach(btn =>
        btn.addEventListener('click', () => _openMgrDetail(btn.dataset.mid))
      );
      $('mgr-d-color')?.addEventListener('input', e => {
        const c = e.target.value;
        const d = $('mgr-detail-dot');
        if (d) d.style.background = c;
        document.querySelectorAll('.mgr-swatch').forEach(s =>
          s.classList.toggle('swatch-active', s.dataset.color === c)
        );
      });
      document.querySelectorAll('.mgr-swatch').forEach(s =>
        s.addEventListener('click', () => {
          const c = s.dataset.color;
          if ($('mgr-d-color')) $('mgr-d-color').value = c;
          const d = $('mgr-detail-dot');
          if (d) d.style.background = c;
          document.querySelectorAll('.mgr-swatch').forEach(sw => sw.classList.toggle('swatch-active', sw === s));
        })
      );
      $('mgr-detail-save')?.addEventListener('click', async () => {
        const mid = $('mgr-detail-del')?.dataset.mid;
        if (!mid) return;
        const mgr = state.managers.find(m => m.id === mid);
        if (!mgr) return;
        const hadDiscordId = mgr.discordId || '';
        const name  = $('mgr-d-name')?.value.trim();
        const color = $('mgr-d-color')?.value;
        if (name)  mgr.name  = name;
        if (color) mgr.color = color;
        const newTeam   = $('mgr-d-team')?.value   || '';
        const newCoteam = $('mgr-d-coteam')?.value || '';
        Object.keys(state.teamOwners).forEach(k   => { if (state.teamOwners[k]   === mid) delete state.teamOwners[k]; });
        Object.keys(state.teamCoOwners).forEach(k => { if (state.teamCoOwners[k] === mid) delete state.teamCoOwners[k]; });
        if (newTeam)   state.teamOwners[newTeam]     = mid;
        if (newCoteam) state.teamCoOwners[newCoteam] = mid;
        const did  = $('mgr-d-discordId')?.value.trim()       || '';
        const dun  = $('mgr-d-discordUsername')?.value.trim() || '';
        const ztag = $('mgr-d-zamboniTag')?.value.trim()      || '';
        if (did)  mgr.discordId       = did;  else delete mgr.discordId;
        if (dun)  mgr.discordUsername = dun;  else delete mgr.discordUsername;
        if (ztag) mgr.zamboniTag      = ztag; else delete mgr.zamboniTag;
        saveState();
        try {
          await _apiFetch('/api/v2/admin/links/sync', {
            method: 'POST',
            body: JSON.stringify({ manager_id: mid, discord_id: did, zamboni_tag: ztag }),
          });
        } catch {}
        _updateMgrListItem(mid);
        if ($('mgr-detail-title')) $('mgr-detail-title').textContent = mgr.name;
        if (color && $('mgr-detail-dot')) $('mgr-detail-dot').style.background = color;
        _mgrPip('mgr-pip-team', !!getManagerTeam(mid));
        _mgrPip('mgr-pip-disc', !!(mgr.discordId || mgr.discordUsername));
        _mgrPip('mgr-pip-zamb', !!mgr.zamboniTag);
        const fb = $('mgr-save-feedback');
        if (fb) { fb.classList.remove('hidden'); setTimeout(() => fb.classList.add('hidden'), 2500); }
        toast(`${mgr.name} saved`, 'success');
      });
      $('mgr-detail-del')?.addEventListener('click', async () => {
        const mid = $('mgr-detail-del').dataset.mid;
        if (!mid) return;
        const mgr = state.managers.find(m => m.id === mid);
        if (!confirm(`Remove manager "${mgr?.name}"? Their portal login link will also be cleared.`)) return;
        state.managers = state.managers.filter(m => m.id !== mid);
        Object.keys(state.teamOwners).forEach(k   => { if (state.teamOwners[k]   === mid) delete state.teamOwners[k]; });
        Object.keys(state.teamCoOwners).forEach(k => { if (state.teamCoOwners[k] === mid) delete state.teamCoOwners[k]; });
        saveState();
        try {
          await _apiFetch('/api/v2/admin/links/unlink', {
            method: 'POST',
            body: JSON.stringify({ manager_id: mid }),
          });
        } catch {}
        renderSettings();
      });
      function _applyMgrFilter() {
        const q    = ($('mgr-search')?.value || '').toLowerCase().trim();
        const filt = $('mgr-filter-status')?.value || '';
        document.querySelectorAll('.mgr-list-item').forEach(btn => {
          const mid  = btn.dataset.mid;
          const mgr  = state.managers.find(m => m.id === mid);
          if (!mgr) { btn.classList.add('hidden'); return; }
          const team  = getManagerTeam(mid);
          const matchQ = !q || mgr.name.toLowerCase().includes(q) || (team||'').toLowerCase().includes(q);
          const matchF = !filt
            || (filt === 'no-team'    && !team)
            || (filt === 'no-discord' && !(mgr.discordId || mgr.discordUsername))
            || (filt === 'no-zamboni' && !mgr.zamboniTag);
          btn.classList.toggle('hidden', !matchQ || !matchF);
        });
      }
      $('mgr-search')?.addEventListener('input', _applyMgrFilter);
      $('mgr-filter-status')?.addEventListener('change', _applyMgrFilter);
      $('add-manager-btn')?.addEventListener('click', () => {
        const name = $('new-manager-name')?.value.trim();
        if (!name) return;
        state.managers.push({ id: uid(), name, color: MANAGER_COLORS[state.managers.length % MANAGER_COLORS.length] });
        $('new-manager-name').value = '';
        saveState();
        renderSettings();
      });
      (() => {
        const inp  = $('mgr-d-zamboniTag');
        const drop = $('zdrop-detail');
        if (!inp || !drop) return;
        inp.addEventListener('focus', () => _getZamboniPlayers(), { once: true });
        inp.addEventListener('input', async () => {
          const q = inp.value.trim().toLowerCase();
          drop.innerHTML = '';
          if (!q) { drop.classList.remove('open'); return; }
          const players = await _getZamboniPlayers();
          const matches = players.filter(p => p.toLowerCase().includes(q)).slice(0, 8);
          if (!matches.length) { drop.classList.remove('open'); return; }
          matches.forEach(tag => {
            const div = document.createElement('div');
            div.className = 'zamboni-option';
            div.textContent = tag;
            div.addEventListener('mousedown', e => {
              e.preventDefault(); inp.value = tag; drop.innerHTML = ''; drop.classList.remove('open');
            });
            drop.appendChild(div);
          });
          drop.classList.add('open');
        });
        inp.addEventListener('blur', () => setTimeout(() => drop.classList.remove('open'), 150));
      })();
      break;
    }

    case 'pending': {
      loadPendingTrades();
      break;
    }

    case 'league': {
      $('save-league-btn')?.addEventListener('click', () => {
        state.league.name = $('set-league-name').value;
        state.league.season = $('set-season').value;
        state.league.draftEnabled = $('set-draft-enabled')?.checked || false;
        const newPw = $('set-admin-pw')?.value?.trim() || '';
        const saveLeague = async () => {
          saveState();
          $('league-title').textContent = state.league.name;
          updateDraftVisibility();
          renderSettings();
          toast('League settings saved', 'success');
        };
        if (!newPw) { saveLeague(); return; }
        _apiFetch('/api/auth/password', { method: 'POST', body: JSON.stringify({ password: newPw }) })
          .then(async r => {
            const body = await r.json().catch(() => ({}));
            if (!r.ok || !body.ok) {
              if (r.status === 401) clearAdminSession({ rerender: true });
              toast(body.error || 'Password update failed', 'error');
              return;
            }
            await saveLeague();
          })
          .catch(() => toast('Password update failed', 'error'));
      });
      
      $('reset-draft-btn')?.addEventListener('click', () => {
        if (!confirm('⚠️ Reset Draft?\n\nThis will clear all draft picks and queues. Player team assignments will NOT be reversed.\n\nThis action cannot be undone!')) return;
        
        const prevAuto = state.liveDraft?.autoManagers || [];
        state.liveDraft = { 
          active: false, 
          rounds: 1, 
          order: [], 
          picks: [], 
          autoManagers: prevAuto,
          playerQueues: {}
        };
        saveState();
        renderSettings();
        toast('Draft has been reset', 'success');
      });
      
      break;
    }

    case 'seasons': {
      $('save-season-btn')?.addEventListener('click', () => {
        const snap = saveSeasonSnapshot();
        toast(`Season ${snap.number} snapshot saved`, 'success');
        renderSettings();
      });
      $('new-season-btn')?.addEventListener('click', startNewSeason);
      document.querySelectorAll('.view-season-btn').forEach(btn =>
        btn.addEventListener('click', () => viewSeasonModal(btn.dataset.sid))
      );
      document.querySelectorAll('.load-season-btn').forEach(btn =>
        btn.addEventListener('click', () => loadSeasonSnapshot(btn.dataset.sid))
      );
      document.querySelectorAll('.del-season-btn').forEach(btn =>
        btn.addEventListener('click', () => {
          if (!isAdmin) return;
          if (!confirm('Delete this season archive?')) return;
          state.seasons = state.seasons.filter(s => s.id !== btn.dataset.sid);
          saveState();
          renderSettings();
        })
      );
      break;
    }

    case 'discord': {
      async function _botApiCall(path, method = 'GET') {
        const r = await fetch(path, { method, headers: { 'Authorization': `Bearer ${_adminToken}` } });
        return r.json();
      }
      async function _refreshBotStatus() {
        const dot   = $('bot-status-dot');
        const label = $('bot-status-label');
        if (!dot) return;
        try {
          const s = await _botApiCall('/api/admin/bot/status');
          dot.style.background = s.running ? 'var(--success)' : '#666';
          label.textContent    = s.running ? `Running (PID ${s.pid})` : 'Stopped';
          const log = $('bot-log');
          if (log && s.logs && s.logs.length) {
            log.style.display = 'block';
            log.textContent   = s.logs.join('\n');
            log.scrollTop     = log.scrollHeight;
          }
        } catch { label.textContent = 'Unavailable'; }
      }
      _refreshBotStatus();
      $('bot-start-btn')?.addEventListener('click', async () => {
        const btn = $('bot-start-btn');
        btn.disabled = true; btn.textContent = 'Starting…';
        const r = await _botApiCall('/api/admin/bot/start', 'POST');
        if (!r.ok) toast(r.error || 'Failed to start bot', 'error');
        else toast('Bot starting…', 'success');
        setTimeout(_refreshBotStatus, 1500);
        btn.disabled = false; btn.textContent = '▶ Start Bot';
      });
      $('bot-stop-btn')?.addEventListener('click', async () => {
        const btn = $('bot-stop-btn');
        btn.disabled = true; btn.textContent = 'Stopping…';
        const r = await _botApiCall('/api/admin/bot/stop', 'POST');
        if (!r.ok) toast(r.error || 'Failed to stop bot', 'error');
        else toast('Bot stopped.', 'success');
        setTimeout(_refreshBotStatus, 800);
        btn.disabled = false; btn.textContent = '■ Stop Bot';
      });
      $('bot-refresh-btn')?.addEventListener('click', _refreshBotStatus);
      
      $('save-discord-cfg-btn')?.addEventListener('click', () => {
        if (!state.discordConfig) state.discordConfig = {};
        state.discordConfig.scoresChannel  = ($('dc-scores')?.value  || '').trim();
        state.discordConfig.tradesChannel  = ($('dc-trades')?.value  || '').trim();
        state.discordConfig.pendingChannel = ($('dc-pending')?.value || '').trim();
        state.discordConfig.signupsChannel = ($('dc-signups')?.value || '').trim();
        state.discordConfig.adminDm        = $('dc-admindm')?.checked !== false;
        saveState();
        toast('Discord settings saved', 'success');
      });
      break;
    }

    case 'playoffs': {
      $('pf-save-btn')?.addEventListener('click', () => {
        const rows = [...document.querySelectorAll('#playoff-format-rows .pf-row')];
        state.playoffFormat = rows.map(row => ({
          name:  row.querySelector('.pf-name-input').value.trim() || `Round ${+row.dataset.idx + 1}`,
          winTo: +row.querySelector('.pf-bo-select').value,
        }));
        saveState();
        toast('Playoff format saved', 'success');
      });
      $('pf-add-btn')?.addEventListener('click', () => {
        const rows = document.querySelectorAll('#playoff-format-rows .pf-row');
        const idx = rows.length;
        const div = document.createElement('div');
        div.className = 'pf-row'; div.dataset.idx = idx;
        div.innerHTML = `
          <span class="pf-round-num">${idx + 1}</span>
          <input type="text" class="pf-name-input" value="Round ${idx + 1}" placeholder="Round name"
            style="flex:1;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:var(--chrome-bright);font-size:.82rem">
          <select class="pf-bo-select" style="padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:var(--chrome-bright);font-size:.82rem">
            ${[3,5,7].map(n=>`<option value="${Math.ceil(n/2)}">Bo${n}</option>`).join('')}
          </select>
          <button class="btn btn-ghost btn-sm pf-del-btn" data-idx="${idx}" style="padding:4px 8px;font-size:.75rem">✕</button>`;
        $('playoff-format-rows').appendChild(div);
        div.querySelector('.pf-del-btn').addEventListener('click', e => { e.target.closest('.pf-row').remove(); });
      });
      document.querySelectorAll('.pf-del-btn').forEach(btn =>
        btn.addEventListener('click', e => { e.target.closest('.pf-row').remove(); })
      );
      break;
    }

    case 'sysdata': {
      // Player attributes JSON upload
      $('upload-attributes-btn')?.addEventListener('click', () => $('attributes-json-input')?.click());
      $('attributes-json-input')?.addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.name.endsWith('.json')) { toast('Please upload a .json file', 'error'); return; }
        try {
          const fd = new FormData();
          fd.append('file', file);
          const r = await fetch('/api/sysdata/attributes', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${_adminToken}` },
            body: fd,
          });
          if (!r.ok) { toast('Upload failed', 'error'); return; }
          const result = await r.json();
          await loadState();
          renderSettings();
          toast(`✅ ${result.stats.players_updated} players updated with attributes!`, 'success');
        } catch (err) {
          toast('Upload error: ' + err.message, 'error');
        }
      });
      
      // SYS-DATA file upload
      $('upload-sysdata-btn')?.addEventListener('click', () => $('sysdata-file-input')?.click());
      $('sysdata-file-input')?.addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) { toast('File too large (max 8 MB)', 'error'); return; }
        const weekVal = parseInt($('sysdata-week-input')?.value) || null;
        try {
          const fd = new FormData();
          fd.append('file', file);
          const r = await fetch('/api/sysdata', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${_adminToken}` },
            body: fd,
          });
          if (!r.ok) { toast('Upload failed', 'error'); return; }
          const meta = await r.json();
          state.sysDataFile = {
            name: meta.name || file.name,
            filename: meta.filename || file.name,
            size: meta.size || file.size,
            uploadedAt: meta.uploadedAt || new Date().toISOString(),
            week: weekVal,
          };
          saveState();
          renderSettings();
          toast(`${file.name} uploaded${weekVal ? ` (Week ${weekVal})` : ''} — members can now download from the dashboard`, 'success');
        } catch (err) {
          toast('Upload error: ' + err.message, 'error');
        }
      });
      $('dl-sysdata-settings-btn')?.addEventListener('click', downloadSysData);
      $('save-sysdata-week-btn')?.addEventListener('click', () => {
        if (!state.sysDataFile) return;
        const w = parseInt($('sysdata-week-input')?.value) || null;
        state.sysDataFile.week = w;
        saveState();
        toast(w ? `Week ${w} saved` : 'Week cleared', 'success');
      });
      $('clear-sysdata-btn')?.addEventListener('click', async () => {
        if (!confirm('Remove the SYS-DATA file?')) return;
        try {
          await fetch('/api/sysdata', { method: 'DELETE', headers: { 'Authorization': `Bearer ${_adminToken}` } });
        } catch {}
        state.sysDataFile = null; saveState(); renderSettings();
      });
      break;
    }

    case 'rules': {
      $('save-rules-btn')?.addEventListener('click', () => {
        state.rules = $('rules-editor').value;
        saveState();
        toast('Rules saved', 'success');
      });
      $('reset-rules-btn')?.addEventListener('click', () => {
        if (!confirm('Reset rules to the default text?')) return;
        state.rules = null;
        saveState();
        renderSettings();
        toast('Rules reset to default', 'success');
      });
      break;
    }

    case 'roster': {
      $('fetch-nhl-btn')?.addEventListener('click', () => fetchNHLRosters({ silent: false }));
      break;
    }

    case 'data': {
      $('migrate-server-btn')?.addEventListener('click', async () => {
        const btn = $('migrate-server-btn');
        const badge = $('api-status-badge');
        btn.disabled = true;
        btn.textContent = 'Pushing…';
        try {
          const r = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(_adminToken ? {'Authorization': `Bearer ${_adminToken}`} : {}) },
            body: JSON.stringify(state),
          });
          if (r.ok) {
            _apiAvailable = true;
            toast('✓ Data migrated to server — all future saves sync automatically', 'success');
            btn.textContent = '↑ Push to Server';
            btn.disabled = false;
            if (badge) { badge.textContent = '✓ Connected to server'; badge.style.color = 'var(--success)'; }
          } else {
            const err = await r.json().catch(() => ({}));
            toast(`Migration failed: ${err.error || r.status}`, 'error');
            btn.disabled = false;
            btn.textContent = '↑ Migrate to Server';
          }
        } catch (e) {
          toast(`Migration failed: ${e.message}`, 'error');
          btn.disabled = false;
          btn.textContent = '↑ Migrate to Server';
        }
      });
      $('export-btn')?.addEventListener('click', () => {
        const json = JSON.stringify(state, null, 2);
        const a = document.createElement('a');
        a.href = 'data:application/json,' + encodeURIComponent(json);
        a.download = `nhl-league-${Date.now()}.json`;
        a.click();
      });
      $('import-btn-show')?.addEventListener('click', () => {
        $('import-area').classList.toggle('hidden');
      });
      $('import-file-input')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        $('import-file-name').textContent = file.name;
        const reader = new FileReader();
        reader.onload = (ev) => { $('import-json').value = ev.target.result; };
        reader.readAsText(file);
      });
      $('import-confirm-btn')?.addEventListener('click', () => {
        try {
          const imported = JSON.parse($('import-json').value);
          Object.assign(state, imported);
          saveState();
          renderSettings();
          toast('League data imported', 'success');
        } catch { toast('Invalid JSON', 'error'); }
      });
      $('reset-btn')?.addEventListener('click', () => {
        if (confirm('Reset ALL league data? This cannot be undone.')) {
          state = defaultState();
          saveState();
          clearAdminSession();
          renderSection('dashboard');
          navigate('dashboard');
          toast('League reset', 'info');
        }
      });
      $('simulate-season-btn')?.addEventListener('click', simulateFullSeason);
      $('admin-logout-btn')?.addEventListener('click', () => {
        clearAdminSession();
        renderSettings();
        toast('Logged out', 'info');
      });
      break;
    }
  }
}
// ================================================================
// 16. ADMIN LOGIN (HEADER BUTTON)
// ================================================================
async function _fetchAdminToken(pw) {
  try {
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (r.ok) {
      const { token } = await r.json();
      _adminToken = token;
      sessionStorage.setItem('nhl-admin-token', token);
      isAdmin = true;
      updateAdminUI();
      return { ok: true };
    }
    const body = await r.json().catch(() => ({}));
    clearAdminSession();
    return { ok: false, error: body.error || 'Login failed', status: r.status };
  } catch {
    clearAdminSession();
    return { ok: false, error: 'Login failed' };
  }
}

function updateAdminUI() {
  $('admin-badge').classList.toggle('hidden', !isAdmin);
  $('admin-toggle-btn').textContent = isAdmin ? 'Logout' : 'Admin Login';
}

function updatePortalUI() {
  $('portal-badge')?.classList.toggle('hidden', !_portalSession?.linked);
  if ($('portal-toggle-btn')) {
    $('portal-toggle-btn').textContent = _portalSession?.user
      ? (_portalSession?.linked ? 'Player Portal' : 'Finish Signup')
      : 'Player Login';
  }
}

function handlePortalToggle() {
  navigate('dashboard');
  const slot = document.querySelector('.portal-dashboard-slot');
  if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (_portalSession?.user) return;
  startPortalLogin();
}

function handlePortalQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const wantsPortal = params.get('portal') === '1';
  const portalError = params.get('portalError');
  if (portalError) {
    toast('Discord sign-in failed. Please try again.', 'error');
  }
  if (wantsPortal) {
    navigate('dashboard');
    setTimeout(() => {
      const slot = document.querySelector('.portal-dashboard-slot');
      if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }
  if (wantsPortal || portalError) {
    params.delete('portal');
    params.delete('portalError');
    const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}${window.location.hash || ''}`;
    window.history.replaceState({}, '', next);
  }
}

function handleAdminToggle() {
  if (isAdmin) {
    clearAdminSession({ rerender: true });
    toast('Logged out', 'info');
    return;
  }
  showModal('Admin Login', `
    <div class="form-row">
      <label>Admin Password</label>
      <input type="password" id="login-pw" placeholder="Enter password" autofocus>
      <p class="text-xs text-dim mt-4">Admin access is granted only after the server verifies your password.</p>
    </div>
    <button id="modal-ok" class="btn btn-primary btn-block mt-12">Login</button>
  `, async () => {
    const pw = $('login-pw').value;
    if (!pw) return;
    const result = await _fetchAdminToken(pw);
    if (result.ok) {
      hideModal();
      renderSection(currentSection);
      toast('Admin access granted', 'success');
    } else {
      toast(result.error || 'Wrong password', 'error');
    }
  });
  // Allow Enter key in password field
  setTimeout(() => {
    $('login-pw')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); $('modal-ok')?.click(); }
    });
  }, 50);
}

// ================================================================
// 17. INIT
// ================================================================
function updateDraftVisibility() {
  const draftBtn = $('draft-nav-btn');
  if (!draftBtn) return;
  draftBtn.style.display = state.league.draftEnabled ? '' : 'none';
}

async function init() {
  // Load state from API (or localStorage fallback) before rendering anything
  state = await loadState();
  loadPortalMatchCache();

  await verifyAdminSession();
  await loadPortalSession();
  if (_portalSession?.user && !_portalSession?.linked) await loadPortalLinkOptions();

  // Show/hide features based on flags
  const statsBtn = $('stats-nav-btn');
  if (statsBtn) statsBtn.style.display = FEATURE_FLAGS.ENABLE_PLAYER_STATS ? '' : 'none';

  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigate(btn.dataset.section);
      // Close hamburger menu after picking a section on mobile
      $('main-nav').classList.remove('nav-open');
      $('hamburger-btn').classList.remove('open');
    });
  });

  // Hamburger menu toggle
  $('hamburger-btn').addEventListener('click', () => {
    $('main-nav').classList.toggle('nav-open');
    $('hamburger-btn').classList.toggle('open');
  });

  // Modal close
  $('modal-close-btn').addEventListener('click', hideModal);
  $('modal-overlay').addEventListener('click', e => { if (e.target === $('modal-overlay')) hideModal(); });

  // Admin toggle
  $('admin-toggle-btn').addEventListener('click', handleAdminToggle);
  $('portal-toggle-btn').addEventListener('click', handlePortalToggle);

  // Set league title
  $('league-title').textContent = state.league.name || 'NHL Legacy League';

  // Update Draft nav button visibility
  updateDraftVisibility();

  // Render initial section
  renderSection('dashboard');
  updateAdminUI();
  updatePortalUI();
  handlePortalQueryParams();

  // Auto-fetch NHL rosters if never loaded, or stale (>30 days)
  const lastFetch = state._lastRosterFetch || 0;
  const stale = Date.now() - lastFetch > 30 * 24 * 60 * 60 * 1000;
  if (!state.players.length || stale) {
    setTimeout(async () => {
      const fresh = !state.players.length;
      if (fresh) toast('Fetching NHL roster data…', 'info');
      await fetchNHLRosters({ silent: true });
      state._lastRosterFetch = Date.now();
      saveState();
      renderSection(currentSection);
      if (fresh) toast(`✓ ${state.players.length} players loaded`, 'success');
    }, 500);
  }
}

// ================================================================
// LIVE UPDATES TEST - DISABLED
// ================================================================
// Removed from dashboard - was causing issues
/*
let _liveTestRunning = false;
let _liveTestInterval = null;

async function startLiveUpdatesTest() {
  const btn = $('test-live-updates-btn');
  if (!btn) return;
  
  if (_liveTestRunning) {
    // Stop test
    _liveTestRunning = false;
    clearInterval(_liveTestInterval);
    btn.textContent = '▶️ Start Test';
    btn.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    toast('Live updates test stopped', 'info');
    return;
  }
  
  // Start test
  _liveTestRunning = true;
  btn.textContent = '⏹️ Stop Test';
  btn.style.background = 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)';
  toast('Live updates test started - watch for notifications!', 'success');
  
  // Submit scores every 3 seconds
  _liveTestInterval = setInterval(async () => {
    if (!_liveTestRunning) return;
    
    // Reload state first to get latest data
    const fresh = await loadState();
    if (fresh) {
      Object.assign(state, fresh, { sysDataFile: state.sysDataFile });
    }
    
    // Find an unplayed game
    let unplayed = state.games.filter(g => !g.played && !g.playoff);
    
    // If no unplayed games, reset all games to unplayed and start over
    if (!unplayed.length) {
      console.log('[Test] No unplayed games - resetting all games');
      toast('🔄 Resetting schedule - starting new season!', 'info');
      
      state.games.forEach(g => {
        if (!g.playoff) {
          g.played = false;
          delete g.homeScore;
          delete g.awayScore;
          delete g.winner;
          delete g.ot;
          delete g.postedAt;
          delete g.playedAt;
          delete g.playerStats;
        }
      });
      
      // Save the reset state
      await saveState();
      
      unplayed = state.games.filter(g => !g.played && !g.playoff);
      
      if (!unplayed.length) {
        toast('No games in schedule - stopping test', 'warning');
        startLiveUpdatesTest(); // Stop
        return;
      }
    }
    
    const game = unplayed[0]; // Take the first unplayed game (consistent order)
    const homeScore = Math.floor(Math.random() * 7);
    const awayScore = Math.floor(Math.random() * 7);
    
    // Get players from both teams for stats
    const homePlayers = state.players.filter(p => p.teamCode === game.homeTeam).slice(0, 6);
    const awayPlayers = state.players.filter(p => p.teamCode === game.awayTeam).slice(0, 6);
    
    // Generate random stats for players
    const generatePlayerStats = (players, teamCode, teamScore, opponentScore) => {
      if (!players.length) return [];
      const stats = [];
      
      // Get skaters and goalies
      const skaters = players.filter(p => p.position !== 'G');
      const goalies = players.filter(p => p.position === 'G');
      
      if (!skaters.length) return stats;
      
      // Distribute goals among skaters to match team score EXACTLY
      let goalsLeft = teamScore;
      const goalScorers = [];
      
      // Randomly assign goals to players
      while (goalsLeft > 0 && goalScorers.length < Math.min(skaters.length, 4)) {
        const goalsForThisPlayer = Math.min(goalsLeft, Math.floor(Math.random() * 3) + 1);
        goalScorers.push(goalsForThisPlayer);
        goalsLeft -= goalsForThisPlayer;
      }
      
      // If still goals left, add them to random scorers
      while (goalsLeft > 0) {
        const idx = Math.floor(Math.random() * goalScorers.length);
        goalScorers[idx]++;
        goalsLeft--;
      }
      
      // Generate stats for up to 6 skaters
      for (let i = 0; i < Math.min(skaters.length, 6); i++) {
        const p = skaters[i];
        const goals = i < goalScorers.length ? goalScorers[i] : 0;
        const assists = Math.floor(Math.random() * Math.min(teamScore, 3));
        const pim = Math.floor(Math.random() * 4);
        const plusMinus = Math.floor(Math.random() * 5) - 2;
        
        stats.push({
          playerId: p.id,
          playerName: p.name,
          teamCode: teamCode,
          position: p.position,
          goals,
          assists,
          points: goals + assists,
          pim,
          plusMinus
        });
      }
      
      // Generate goalie stats (pick one goalie)
      if (goalies.length > 0) {
        const goalie = goalies[0];
        const goalsAgainst = opponentScore;
        const shotsAgainst = goalsAgainst + Math.floor(Math.random() * 20) + 10; // 10-30 shots
        const saves = shotsAgainst - goalsAgainst;
        const savePercentage = shotsAgainst > 0 ? saves / shotsAgainst : 0;
        
        stats.push({
          playerId: goalie.id,
          playerName: goalie.name,
          teamCode: teamCode,
          position: 'G',
          shotsAgainst,
          saves,
          goalsAgainst,
          savePercentage,
          shutout: goalsAgainst === 0
        });
      }
      
      return stats;
    };
    
    const homeStats = generatePlayerStats(homePlayers, game.homeTeam, homeScore, awayScore);
    const awayStats = generatePlayerStats(awayPlayers, game.awayTeam, awayScore, homeScore);
    
    console.log(`[Test] Generated stats: ${homeStats.length} home, ${awayStats.length} away`);
    
    try {
      const resp = await fetch('/api/bot/score', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Secret': 'crisply!wrongly!spoiled!cringing!definite'
        },
        body: JSON.stringify({
          gameId: game.id,
          homeScore,
          awayScore,
          ot: Math.random() > 0.8,
          homeStats,
          awayStats
        })
      });
      
      if (resp.ok) {
        const statsCount = homeStats.length + awayStats.length;
        console.log(`[Test] ⚽ Score submitted: ${game.homeTeam} ${homeScore} - ${awayScore} ${game.awayTeam} (${statsCount} player stats)`);
        toast(`⚽ ${game.homeTeam} ${homeScore} - ${awayScore} ${game.awayTeam} + stats`, 'success');
      }
    } catch (err) {
      console.error('[Test] Score submission failed:', err);
    }
  }, 3000);
}
*/

document.addEventListener('DOMContentLoaded', init);
