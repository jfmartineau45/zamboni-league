'use strict';

function defaultPortalSession() {
  return { user: null, linked: false, manager: null, teamCode: null, currentWeek: null };
}

function syncPortalSession(data = {}) {
  _portalSession = {
    ...defaultPortalSession(),
    ...(data || {}),
  };
  return _portalSession;
}

function resetPortalState() {
  syncPortalSession();
  _portalGames = [];
  _portalLinkOptions = [];
  _portalMatchCache = {};
  _portalMatchInflight = {};
  _portalTradesBadgeAt = 0;
  savePortalMatchCache();
  clearCachedPortalTrades();
  clearInflightPortalTrades();
}

function loadPortalMatchCache() {
  try {
    const raw = sessionStorage.getItem(_PORTAL_MATCH_CACHE_KEY);
    if (!raw) {
      _portalMatchCache = {};
      return _portalMatchCache;
    }
    const parsed = JSON.parse(raw);
    const now = Date.now();
    _portalMatchCache = Object.fromEntries(
      Object.entries(parsed || {}).filter(([, value]) => value?.at && now - value.at < _PORTAL_MATCH_CACHE_TTL)
    );
    return _portalMatchCache;
  } catch {
    _portalMatchCache = {};
    return _portalMatchCache;
  }
}

function savePortalMatchCache() {
  try {
    sessionStorage.setItem(_PORTAL_MATCH_CACHE_KEY, JSON.stringify(_portalMatchCache));
  } catch {}
}

function getCachedPortalMatches(gameId) {
  const entry = _portalMatchCache[String(gameId)];
  if (!entry) return null;
  if (Date.now() - entry.at >= _PORTAL_MATCH_CACHE_TTL) {
    delete _portalMatchCache[String(gameId)];
    savePortalMatchCache();
    return null;
  }
  return entry.data || null;
}

function setCachedPortalMatches(gameId, data) {
  _portalMatchCache[String(gameId)] = { at: Date.now(), data };
  savePortalMatchCache();
}

function getInflightPortalMatches(gameId) {
  return _portalMatchInflight[String(gameId)] || null;
}

function setInflightPortalMatches(gameId, promise) {
  _portalMatchInflight[String(gameId)] = promise;
}

function clearInflightPortalMatches(gameId) {
  delete _portalMatchInflight[String(gameId)];
}

function getCachedPortalTrades() {
  if (!_portalTradesCache?.at || !_portalTradesCache?.data) return null;
  if (Date.now() - _portalTradesCache.at >= 15000) {
    _portalTradesCache = null;
    return null;
  }
  return _portalTradesCache.data;
}

function setCachedPortalTrades(data) {
  _portalTradesCache = { at: Date.now(), data };
}

function clearCachedPortalTrades() {
  _portalTradesCache = null;
}

function getInflightPortalTrades() {
  return _portalTradesInflight;
}

function setInflightPortalTrades(promise) {
  _portalTradesInflight = promise;
}

function clearInflightPortalTrades() {
  _portalTradesInflight = null;
}

async function fetchPortalTrades({ preferCache = true } = {}) {
  if (preferCache) {
    const cached = getCachedPortalTrades();
    if (cached) return cached;
  }
  const inflight = getInflightPortalTrades();
  if (inflight) return inflight;
  const request = (async () => {
    const r = await _portalFetch('/api/v2/me/trades');
    const contentType = r.headers.get('content-type') || '';
    const raw = await r.text();
    const data = contentType.includes('application/json') ? JSON.parse(raw || '{}') : null;
    if (!r.ok) {
      return { ...(data || {}), _ok: false, _status: r.status };
    }
    if (!data) {
      throw new Error('Trades endpoint did not return JSON');
    }
    const result = { ...data, _ok: true, _status: r.status };
    setCachedPortalTrades(result);
    return result;
  })();
  setInflightPortalTrades(request);
  try {
    return await request;
  } finally {
    clearInflightPortalTrades();
  }
}

async function loadPortalSession() {
  try {
    const r = await _portalFetch('/api/v2/user/session');
    if (!r.ok) {
      resetPortalState();
      return _portalSession;
    }
    syncPortalSession(await r.json());
    if (_portalSession?.linked) {
      _portalLinkOptions = [];
      await loadPortalGames();
    } else {
      _portalGames = [];
    }
    return _portalSession;
  } catch {
    resetPortalState();
    return _portalSession;
  }
}

async function loadZamboniPlayers() {
  if (Array.isArray(_zamboniPlayers) && _zamboniPlayers.length) return _zamboniPlayers;
  try {
    const r = await _portalFetch('/api/zamboni/players');
    const body = await r.json().catch(() => ([]));
    if (!r.ok || !Array.isArray(body)) {
      _zamboniPlayers = [];
      return _zamboniPlayers;
    }
    _zamboniPlayers = body
      .map(item => typeof item === 'string' ? item : (item?.gamertag || item?.name || ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return _zamboniPlayers;
  } catch {
    _zamboniPlayers = [];
    return _zamboniPlayers;
  }
}

function rpcnAutocompleteMatches(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q || !_zamboniPlayers?.length) return [];
  const starts = [];
  const contains = [];
  for (const tag of _zamboniPlayers) {
    const lower = tag.toLowerCase();
    if (lower.startsWith(q)) starts.push(tag);
    else if (lower.includes(q)) contains.push(tag);
    if (starts.length + contains.length >= 8) break;
  }
  return [...starts, ...contains].slice(0, 8);
}

function renderRpcnAutocomplete(query) {
  const drop = $('portal-rpcn-drop');
  const status = $('portal-rpcn-status');
  if (!drop) return;
  const matches = rpcnAutocompleteMatches(query);
  const clean = (query || '').trim();
  if (!clean) {
    drop.classList.remove('open');
    drop.innerHTML = '';
    if (status) status.textContent = 'Start typing your RPCN account for suggestions.';
    return;
  }
  if (!matches.length) {
    drop.classList.remove('open');
    drop.innerHTML = '';
    if (status) status.textContent = _zamboniPlayers?.length ? 'No matching RPCN account found yet.' : 'RPCN suggestions unavailable right now.';
    return;
  }
  drop.innerHTML = matches.map(tag => `<button type="button" class="zamboni-option" data-tag="${tag.replace(/"/g, '&quot;')}">${tag}</button>`).join('');
  drop.classList.add('open');
  if (status) status.textContent = `${matches.length} suggestion${matches.length === 1 ? '' : 's'} found.`;
  drop.querySelectorAll('.zamboni-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $('portal-zamboni-tag');
      if (!input) return;
      input.value = btn.dataset.tag || '';
      drop.classList.remove('open');
      drop.innerHTML = '';
      if (status) status.textContent = `Selected RPCN account: ${input.value}`;
      input.focus();
    });
  });
}
