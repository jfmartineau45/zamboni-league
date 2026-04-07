window.DraftModule = (() => {
  let draftUiState = {
    availableSearch: '',
    availablePosition: 'ALL',
    availableScrollTop: 0,
    panelMode: 'targets',
    selectedQueueManagerId: '',
    queuedPlayerIdsByManager: {},
  };

  function getDraftState(ctx) {
    const state = ctx.getState();
    const draft = state.liveDraft || { active: false, rounds: 1, order: [], picks: [], autoManagers: [] };
    const managerCount = draft.order.length;
    const totalPicks = managerCount * (draft.rounds || 0);
    const currentIdx = draft.picks.length;
    const isDone = !managerCount || currentIdx >= totalPicks;
    const roundNum = managerCount ? Math.floor(currentIdx / managerCount) : 0;
    const pickInRound = managerCount ? currentIdx % managerCount : 0;
    const roundOrder = roundNum % 2 === 0 ? draft.order : [...draft.order].reverse();
    const onClockId = isDone ? null : roundOrder[pickInRound];
    const onClockTeam = onClockId ? ctx.getManagerTeam(onClockId) : '';

    const pickedIds = new Set(draft.picks.map((pick) => pick.playerId));
    const availablePlayers = state.players.filter((player) => !pickedIds.has(player.id));

    const managerPosCounts = {};
    draft.picks.forEach((pick) => {
      if (!managerPosCounts[pick.managerId]) managerPosCounts[pick.managerId] = { F: 0, D: 0, G: 0 };
      managerPosCounts[pick.managerId][ctx.posGroup(pick.position || '')]++;
    });

    const clockCounts = onClockId
      ? (managerPosCounts[onClockId] || { F: 0, D: 0, G: 0 })
      : { F: 0, D: 0, G: 0 };

    return {
      state,
      draft,
      managerCount,
      totalPicks,
      currentIdx,
      isDone,
      roundNum,
      pickInRound,
      onClockId,
      onClockTeam,
      availablePlayers,
      managerPosCounts,
      clockCounts,
    };
  }

  function sortAvailablePlayers(players) {
    return [...players].sort((a, b) => {
      if ((b.ovr || 0) !== (a.ovr || 0)) return (b.ovr || 0) - (a.ovr || 0);
      return a.name.localeCompare(b.name);
    });
  }

  function getFilteredAvailablePlayers(ctx, availablePlayers) {
    const searchValue = draftUiState.availableSearch.trim().toLowerCase();
    const positionValue = draftUiState.availablePosition;
    return sortAvailablePlayers(availablePlayers)
      .filter((player) => !searchValue || player.name.toLowerCase().includes(searchValue))
      .filter((player) => positionValue === 'ALL' || ctx.posGroup(player.position || '') === positionValue);
  }

  function positionFilterButton(label, value, count) {
    const active = draftUiState.availablePosition === value;
    return `<button class="btn btn-xs ${active ? 'btn-primary' : 'btn-ghost'} draft-pos-filter-btn" data-pos="${value}" style="font-size:.68rem;padding:4px 8px">${label} ${count}</button>`;
  }

  function panelModeButton(label, value) {
    const active = draftUiState.panelMode === value;
    return `<button class="btn btn-xs ${active ? 'btn-primary' : 'btn-ghost'} draft-panel-mode-btn" data-mode="${value}" style="font-size:.68rem;padding:4px 8px">${label}</button>`;
  }

  function getQueueManagerOptions(ctx, draft, onClockId) {
    const managerIds = draft.order || [];
    if (!draftUiState.selectedQueueManagerId || !managerIds.includes(draftUiState.selectedQueueManagerId)) {
      draftUiState.selectedQueueManagerId = onClockId && managerIds.includes(onClockId)
        ? onClockId
        : (managerIds[0] || '');
    }
    return managerIds.map((managerId) => {
      const managerTeam = ctx.getManagerTeam(managerId);
      const selected = managerId === draftUiState.selectedQueueManagerId ? 'selected' : '';
      return `<option value="${managerId}" ${selected}>${ctx.managerName(managerId)} ${managerTeam ? `(${managerTeam})` : ''}</option>`;
    }).join('');
  }

  function getActiveQueueIds() {
    const managerId = draftUiState.selectedQueueManagerId;
    if (!managerId) return [];
    if (!draftUiState.queuedPlayerIdsByManager[managerId]) draftUiState.queuedPlayerIdsByManager[managerId] = [];
    return draftUiState.queuedPlayerIdsByManager[managerId];
  }

  function getQueuedPlayers(ctx, availablePlayers) {
    const queueIds = getActiveQueueIds();
    const queued = queueIds
      .map((playerId) => availablePlayers.find((player) => player.id === playerId))
      .filter(Boolean);
    if (draftUiState.selectedQueueManagerId) {
      draftUiState.queuedPlayerIdsByManager[draftUiState.selectedQueueManagerId] = queued.map((player) => player.id);
    }
    return queued;
  }

  function getSuggestedTargets(ctx, players, clockCounts) {
    const sorted = sortAvailablePlayers(players);
    const preferredGroups = ['F', 'D', 'G'].sort((a, b) => {
      const aNeed = ctx.positionLimits[a] - clockCounts[a];
      const bNeed = ctx.positionLimits[b] - clockCounts[b];
      return bNeed - aNeed;
    });
    return [...sorted].sort((a, b) => {
      const aGroup = preferredGroups.indexOf(ctx.posGroup(a.position || ''));
      const bGroup = preferredGroups.indexOf(ctx.posGroup(b.position || ''));
      if (aGroup !== bGroup) return aGroup - bGroup;
      return (b.ovr || 0) - (a.ovr || 0);
    });
  }

  function renderAvailableRows(ctx, players, { isDone, clockCounts, emptyText }) {
    const canPickGroup = (group) => clockCounts[group] < ctx.positionLimits[group];
    const activeQueueIds = getActiveQueueIds();
    return players.map((player) => {
      const group = ctx.posGroup(player.position || '');
      const blocked = !isDone && !canPickGroup(group);
      const queued = activeQueueIds.includes(player.id);
      return `
        <div class="draft-player-row${blocked ? ' pos-full' : ''}">
          <span class="draft-player-info">
            ${player.headshot ? `<img src="${player.headshot}" class="draft-headshot" loading="lazy" onerror="this.style.display='none'">` : '<div class="draft-headshot-ph"></div>'}
            <span class="draft-player-name">
              ${player.name}
              ${player.position ? `<span class="pos-badge pos-${player.position}">${player.position}</span>` : ''}
              ${player.ovr ? ctx.ovrBadge(player.ovr) : ''}
              ${player.plt ? ctx.pltBadge(player.plt) : ''}
              ${player.number ? `<span class="text-dim text-xs">#${player.number}</span>` : ''}
            </span>
          </span>
          <span class="draft-player-actions">
            <button class="btn btn-ghost btn-xs draft-queue-btn" data-pid="${player.id}" style="font-size:.68rem;padding:2px 6px">${queued ? '★' : '+'}</button>
            ${ctx.isAdmin() && !isDone
              ? (blocked
                  ? `<span class="draft-full-label">${group} FULL</span>`
                  : `<button class="btn btn-primary btn-sm pick-player-btn" data-pid="${player.id}">Pick</button>`)
              : ''}
          </span>
        </div>`;
    }).join('') || `<div class="text-dim text-sm" style="padding:12px">${emptyText}</div>`;
  }

  function updateAvailablePanel(ctx, options = {}) {
    const view = getDraftState(ctx);
    const { draft, availablePlayers, isDone, clockCounts, onClockId } = view;
    const searchInput = ctx.$('draft-search');
    if (searchInput && document.activeElement === searchInput) {
      draftUiState.availableSearch = searchInput.value;
    }

    const filteredAvailable = getFilteredAvailablePlayers(ctx, availablePlayers);
    const queuedPlayers = getQueuedPlayers(ctx, availablePlayers)
      .filter((player) => !draftUiState.availableSearch || player.name.toLowerCase().includes(draftUiState.availableSearch.toLowerCase()))
      .filter((player) => draftUiState.availablePosition === 'ALL' || ctx.posGroup(player.position || '') === draftUiState.availablePosition);
    const targetPlayers = getSuggestedTargets(ctx, filteredAvailable, clockCounts).slice(0, 10);
    const fullPoolPlayers = filteredAvailable.slice(0, 40);

    let title = 'Top Targets';
    let body = '';
    if (draftUiState.panelMode === 'queue') {
      title = `Queue (${queuedPlayers.length})`;
      body = renderAvailableRows(ctx, queuedPlayers, { isDone, clockCounts, emptyText: 'No queued players yet' });
    } else if (draftUiState.panelMode === 'pool') {
      title = `Full Pool (${filteredAvailable.length})`;
      body = renderAvailableRows(ctx, fullPoolPlayers, { isDone, clockCounts, emptyText: 'No players available' });
    } else {
      body = renderAvailableRows(ctx, targetPlayers, { isDone, clockCounts, emptyText: 'No target players available' });
    }

    const titleNode = ctx.$('draft-available-title');
    const listNode = ctx.$('draft-avail-list');
    const modeNode = ctx.$('draft-panel-mode-row');
    const filterNode = ctx.$('draft-filter-chip-row');
    const managerNode = ctx.$('draft-queue-manager');
    const searchNode = ctx.$('draft-search');
    const availableCounts = {
      ALL: availablePlayers.length,
      F: availablePlayers.filter((player) => ctx.posGroup(player.position || '') === 'F').length,
      D: availablePlayers.filter((player) => ctx.posGroup(player.position || '') === 'D').length,
      G: availablePlayers.filter((player) => ctx.posGroup(player.position || '') === 'G').length,
    };
    if (titleNode) titleNode.textContent = title;
    if (modeNode) {
      modeNode.innerHTML = [
        panelModeButton('Top Targets', 'targets'),
        panelModeButton('Queue', 'queue'),
        panelModeButton('Full Pool', 'pool'),
      ].join('');
    }
    if (managerNode) {
      managerNode.innerHTML = getQueueManagerOptions(ctx, draft, onClockId);
    }
    if (filterNode) {
      filterNode.innerHTML = [
        positionFilterButton('All', 'ALL', availableCounts.ALL),
        positionFilterButton('F', 'F', availableCounts.F),
        positionFilterButton('D', 'D', availableCounts.D),
        positionFilterButton('G', 'G', availableCounts.G),
      ].join('');
    }
    if (listNode) {
      listNode.innerHTML = body;
      if (typeof options.restoreScrollTop === 'number') listNode.scrollTop = options.restoreScrollTop;
    }
    if (searchNode && options.keepSearchFocus) {
      searchNode.focus();
      const end = searchNode.value.length;
      searchNode.setSelectionRange(end, end);
    }
  }

  function attachAvailablePanelHandlers(ctx) {
    const panel = ctx.$('draft-panel-root');
    const availableList = ctx.$('draft-avail-list');
    const queueManagerSelect = ctx.$('draft-queue-manager');
    if (!panel) return;

    panel.onclick = (e) => {
      const modeBtn = e.target.closest('.draft-panel-mode-btn');
      if (modeBtn) {
        draftUiState.panelMode = modeBtn.dataset.mode;
        draftUiState.availableScrollTop = 0;
        updateAvailablePanel(ctx, { restoreScrollTop: 0 });
        return;
      }

      const posBtn = e.target.closest('.draft-pos-filter-btn');
      if (posBtn) {
        draftUiState.availablePosition = posBtn.dataset.pos;
        draftUiState.availableScrollTop = 0;
        updateAvailablePanel(ctx, { restoreScrollTop: 0 });
        return;
      }

      const queueBtn = e.target.closest('.draft-queue-btn');
      if (queueBtn) {
        const playerId = Number(queueBtn.dataset.pid);
        const activeQueueIds = getActiveQueueIds();
        const idx = activeQueueIds.indexOf(playerId);
        if (idx === -1) activeQueueIds.unshift(playerId);
        else activeQueueIds.splice(idx, 1);
        updateAvailablePanel(ctx, { restoreScrollTop: ctx.$('draft-avail-list')?.scrollTop || 0 });
        return;
      }

      const pickBtn = e.target.closest('.pick-player-btn');
      if (pickBtn) {
        handleDraftPick(ctx, Number(pickBtn.dataset.pid));
      }
    };

    if (availableList) {
      availableList.onscroll = () => {
        draftUiState.availableScrollTop = availableList.scrollTop;
      };
    }
    if (queueManagerSelect) {
      queueManagerSelect.onchange = (e) => {
        draftUiState.selectedQueueManagerId = e.target.value;
        draftUiState.availableScrollTop = 0;
        updateAvailablePanel(ctx, { restoreScrollTop: 0 });
      };
    }
  }

  function renderDraft(ctx) {
    const { state, draft } = getDraftState(ctx);
    const el = ctx.$('section-draft');
    if (!el) return;

    const summary = draft.active
      ? `${draft.picks.length} / ${Math.max(0, draft.order.length * draft.rounds)} picks`
      : (state.players.length ? 'Ready to configure a live draft' : 'Fetch rosters before starting');

    el.innerHTML = `
      <div class="page-header">
        <div>
          <h2>Draft</h2>
          <div class="text-xs text-muted mt-4">Live draft module · ${summary}</div>
        </div>
        <div class="flex gap-8">
          ${ctx.isAdmin() && !draft.active ? '<button class="btn btn-primary btn-sm" id="setup-live-draft-btn">Setup Draft</button>' : ''}
          ${ctx.isAdmin() && draft.active ? '<button class="btn btn-secondary btn-sm" id="reset-live-draft-btn">Reset Draft</button>' : ''}
        </div>
      </div>
      <div id="draft-tab-content"></div>
    `;

    ctx.$('setup-live-draft-btn')?.addEventListener('click', () => showSetupLiveDraft(ctx));
    ctx.$('reset-live-draft-btn')?.addEventListener('click', () => {
      if (!confirm('Reset all live draft picks? Player team assignments made during the draft will NOT be reversed.')) return;
      const nextState = structuredClone(ctx.getState());
      const prevAuto = nextState.liveDraft?.autoManagers || [];
      nextState.liveDraft = { active: false, rounds: 1, order: [], picks: [], autoManagers: prevAuto };
      ctx.setState(nextState);
      ctx.saveState();
      renderDraft(ctx);
    });

    renderLiveDraftTab(ctx);
  }

  function handleDraftPick(ctx, playerId) {
    const view = getDraftState(ctx);
    const { isDone, roundNum, currentIdx, onClockId, onClockTeam } = view;
    if (!ctx.isAdmin() || isDone) return;

    const nextState = structuredClone(ctx.getState());
    const player = nextState.players.find((item) => item.id === playerId);
    if (!player) return;

    nextState.liveDraft.picks.push({
      round: roundNum + 1,
      pick: currentIdx + 1,
      managerId: onClockId,
      teamCode: onClockTeam,
      playerId,
      playerName: player.name,
      position: player.position || '',
    });
    player.teamCode = onClockTeam;
    draftUiState.availableScrollTop = ctx.$('draft-avail-list')?.scrollTop || draftUiState.availableScrollTop;
    Object.keys(draftUiState.queuedPlayerIdsByManager).forEach((managerId) => {
      const queue = draftUiState.queuedPlayerIdsByManager[managerId] || [];
      const queueIdx = queue.indexOf(playerId);
      if (queueIdx !== -1) queue.splice(queueIdx, 1);
    });
    ctx.setState(nextState);
    ctx.saveState();
    renderLiveDraftTab(ctx);
  }

  function renderLiveDraftTab(ctx) {
    const view = getDraftState(ctx);
    const { draft, state, totalPicks, currentIdx, isDone, roundNum, pickInRound, onClockId, onClockTeam, availablePlayers, clockCounts } = view;
    const container = ctx.$('draft-tab-content');
    if (!container) return;

    if (!draft.active) {
      container.innerHTML = `
        <div class="empty-state" style="padding:60px 0">
          <p>${state.players.length ? 'Draft not started yet.' : 'Fetch NHL rosters in Settings first to get the player list.'}</p>
          ${ctx.isAdmin() && state.players.length ? '<p class="mt-12"><button class="btn btn-primary" id="setup-live-draft-btn2">Setup Draft</button></p>' : ''}
        </div>`;
      ctx.$('setup-live-draft-btn2')?.addEventListener('click', () => showSetupLiveDraft(ctx));
      return;
    }

    const recentPicks = [...draft.picks].slice(-8).reverse();
    const boardPicks = [...draft.picks].reverse();
    const filteredAvailable = getFilteredAvailablePlayers(ctx, availablePlayers);
    const availableCounts = {
      ALL: availablePlayers.length,
      F: availablePlayers.filter((player) => ctx.posGroup(player.position || '') === 'F').length,
      D: availablePlayers.filter((player) => ctx.posGroup(player.position || '') === 'D').length,
      G: availablePlayers.filter((player) => ctx.posGroup(player.position || '') === 'G').length,
    };
    const progressPct = totalPicks ? Math.round((draft.picks.length / totalPicks) * 100) : 0;

    container.innerHTML = `
      <div class="draft-session-shell">
        <div class="draft-layout">
        <div>
          ${!isDone ? `
            <div class="card draft-hero-card mb-16" style="border-color:var(--gold);background:rgba(200,168,78,.06)">
              <div class="draft-hero-topline">
                <div class="text-xs text-muted">ON THE CLOCK — Round ${roundNum + 1}, Pick ${pickInRound + 1}</div>
                <div class="draft-hero-stats">
                  <span>${draft.picks.length}/${totalPicks || 0}</span>
                  <span>${availablePlayers.length} pool</span>
                  <span>${filteredAvailable.length} shown</span>
                </div>
              </div>
              <div class="draft-hero-main">
                <div class="draft-hero-ident">
                  ${ctx.teamLogoLg(onClockTeam, 42)}
                  <div>
                    <div style="font-size:1.1rem;font-weight:800;color:var(--gold)">${ctx.managerName(onClockId)}</div>
                    <div style="margin-top:3px">${ctx.teamBadge(onClockTeam)}</div>
                  </div>
                </div>
                <div class="draft-progress-mini"><span style="width:${progressPct}%"></span></div>
              </div>
              <div class="draft-hero-bottom">
                <div class="pos-counts">
                  <span class="pos-count${clockCounts.F >= ctx.positionLimits.F ? ' pos-count-full' : ''}">F ${clockCounts.F}/${ctx.positionLimits.F}</span>
                  <span class="pos-count${clockCounts.D >= ctx.positionLimits.D ? ' pos-count-full' : ''}">D ${clockCounts.D}/${ctx.positionLimits.D}</span>
                  <span class="pos-count${clockCounts.G >= ctx.positionLimits.G ? ' pos-count-full' : ''}">G ${clockCounts.G}/${ctx.positionLimits.G}</span>
                </div>
                ${ctx.isAdmin() ? '<button class="btn btn-ghost btn-sm" id="auto-pick-btn">⚡ Auto Pick Once</button>' : ''}
              </div>
            </div>` : `
            <div class="card draft-hero-card mb-16" style="border-color:var(--success)">
              <div style="font-size:1.1rem;font-weight:700;color:var(--success)">Draft Complete — ${draft.picks.length} picks made</div>
            </div>`}

          <div class="draft-secondary-grid mb-16">
            <div class="card draft-compact-card">
              <div class="card-title">Recent</div>
              <div class="draft-compact-stack">
                ${recentPicks.length ? recentPicks.slice(0, 3).map((pick) => `
                  <div class="draft-mini-pick">
                    <div style="display:flex;justify-content:space-between;gap:8px">
                      <strong>#${pick.pick}</strong>
                      <span class="text-xs text-muted">Rd ${pick.round}</span>
                    </div>
                    <div style="margin-top:4px">${pick.playerName}</div>
                    <div class="text-xs text-muted mt-4">${ctx.teamBadge(pick.teamCode)} ${ctx.managerName(pick.managerId)}</div>
                  </div>`).join('') : '<div class="text-dim text-sm">No picks yet</div>'}
              </div>
            </div>

            ${ctx.isAdmin() && !isDone ? `
              <div class="card draft-compact-card">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                  <span class="card-title" style="font-size:.78rem;margin:0">🤖 Auto-Draft</span>
                  <div style="display:flex;gap:4px">
                    <button class="btn btn-xs btn-primary" id="auto-all-btn" style="font-size:.65rem;padding:2px 5px">All ON</button>
                    <button class="btn btn-xs btn-ghost" id="auto-none-btn" style="font-size:.65rem;padding:2px 5px">All OFF</button>
                  </div>
                </div>
                <div class="draft-compact-stack">
                  ${draft.order.map((managerId) => {
                    const isAuto = (draft.autoManagers || []).includes(managerId);
                    const managerTeam = ctx.getManagerTeam(managerId);
                    return `<div class="draft-auto-row">
                      <span style="font-size:.78rem;${managerId === onClockId ? 'font-weight:700;color:var(--gold)' : ''}">${ctx.teamBadge(managerTeam)} ${ctx.managerName(managerId)}</span>
                      <button class="btn btn-xs ${isAuto ? 'btn-primary' : 'btn-ghost'} auto-mgr-toggle" data-mid="${managerId}" style="font-size:.68rem;padding:2px 6px">${isAuto ? '🤖 ON' : 'OFF'}</button>
                    </div>`;
                  }).join('')}
                </div>
              </div>` : ''}
          </div>

          <div class="card mb-16">
            <div class="draft-card-header-tight">
              <div class="card-title">Draft Board</div>
              <div class="text-xs text-muted">${draft.picks.length}/${totalPicks}</div>
            </div>
            <div class="table-wrap" style="max-height:360px;overflow-y:auto">
              <table>
                <thead><tr><th>#</th><th>Manager</th><th>Team</th><th>Player</th>${ctx.isAdmin() ? '<th></th>' : ''}</tr></thead>
                <tbody>
                  ${draft.picks.length ? boardPicks.map((pick) => {
                    const pickIdx = pick.pick - 1;
                    return `<tr>
                      <td class="num text-dim">${pick.pick}</td>
                      <td style="font-weight:600">${ctx.managerName(pick.managerId)}</td>
                      <td>${ctx.teamBadge(pick.teamCode)}</td>
                      <td>${pick.playerName}</td>
                      ${ctx.isAdmin() ? `<td><button class="btn btn-ghost btn-xs edit-pick-btn" data-idx="${pickIdx}" style="font-size:.7rem;padding:2px 6px">✎</button></td>` : ''}
                    </tr>`;
                  }).join('') : '<tr><td colspan="5" class="text-dim">No picks yet</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="draft-card-header-tight">
              <div class="card-title">Order</div>
              <div class="text-xs text-muted">Rd ${roundNum + 1}</div>
            </div>
            <div style="display:grid;gap:6px">
              ${draft.order.map((managerId, idx) => {
                const managerTeam = ctx.getManagerTeam(managerId);
                const onClock = managerId === onClockId;
                return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border);border-radius:6px;${onClock ? 'background:rgba(200,168,78,.08);border-color:var(--gold)' : ''}">
                  <span>${idx + 1}. ${ctx.teamBadge(managerTeam)} ${ctx.managerName(managerId)}</span>
                  <span class="text-xs text-muted">${(draft.autoManagers || []).includes(managerId) ? 'AUTO' : 'MANUAL'}</span>
                </div>`;
              }).join('')}
            </div>
          </div>
        </div>

        <div class="draft-sidebar">
          <div class="card draft-available-card" id="draft-panel-root">
            <div class="draft-card-header-tight">
              <div class="card-title" id="draft-available-title">Top Targets</div>
              <div class="text-xs text-muted">${availablePlayers.length}</div>
            </div>
            <div class="draft-available-tools">
              <div id="draft-panel-mode-row" class="draft-panel-mode-row">
                ${panelModeButton('Top Targets', 'targets')}
                ${panelModeButton('Queue', 'queue')}
                ${panelModeButton('Full Pool', 'pool')}
              </div>
              <div class="draft-filter-chip-row" id="draft-filter-chip-row">
                ${positionFilterButton('All', 'ALL', availableCounts.ALL)}
                ${positionFilterButton('F', 'F', availableCounts.F)}
                ${positionFilterButton('D', 'D', availableCounts.D)}
                ${positionFilterButton('G', 'G', availableCounts.G)}
              </div>
              <select id="draft-queue-manager" style="width:100%;margin-bottom:6px">
                ${getQueueManagerOptions(ctx, draft, onClockId)}
              </select>
              <input type="text" id="draft-search" placeholder="Search players…" value="${draftUiState.availableSearch.replace(/"/g, '&quot;')}" style="width:100%;margin-bottom:4px">
            </div>
            <div id="draft-avail-list" class="available-list"></div>
          </div>
        </div>
      </div>
      </div>`;

    attachDraftHandlers(ctx);

    updateAvailablePanel(ctx, { restoreScrollTop: draftUiState.availableScrollTop });
    attachAvailablePanelHandlers(ctx);

    if (ctx.isAdmin() && !isDone && (draft.autoManagers || []).includes(onClockId)) {
      setTimeout(() => {
        const next = getDraftState(ctx);
        if (next.isDone || !next.onClockId) return;
        if ((next.draft.autoManagers || []).includes(next.onClockId)) {
          autoDraftPick(ctx);
        }
      }, 700);
    }
  }

  function attachDraftHandlers(ctx) {
    const view = getDraftState(ctx);
    const { draft } = view;
    const container = ctx.$('draft-tab-content');
    if (!container) return;

    ctx.$('draft-search')?.addEventListener('input', (e) => {
      draftUiState.availableSearch = e.target.value;
      draftUiState.availableScrollTop = 0;
      updateAvailablePanel(ctx, { restoreScrollTop: 0, keepSearchFocus: true });
    });
    ctx.$('auto-pick-btn')?.addEventListener('click', () => autoDraftPick(ctx));
    ctx.$('auto-all-btn')?.addEventListener('click', () => {
      const nextState = structuredClone(ctx.getState());
      nextState.liveDraft.autoManagers = [...draft.order];
      ctx.setState(nextState);
      ctx.saveState();
      renderLiveDraftTab(ctx);
    });
    ctx.$('auto-none-btn')?.addEventListener('click', () => {
      const nextState = structuredClone(ctx.getState());
      nextState.liveDraft.autoManagers = [];
      ctx.setState(nextState);
      ctx.saveState();
      renderLiveDraftTab(ctx);
    });

    container.querySelectorAll('.auto-mgr-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextState = structuredClone(ctx.getState());
        if (!nextState.liveDraft.autoManagers) nextState.liveDraft.autoManagers = [];
        const idx = nextState.liveDraft.autoManagers.indexOf(btn.dataset.mid);
        if (idx === -1) nextState.liveDraft.autoManagers.push(btn.dataset.mid);
        else nextState.liveDraft.autoManagers.splice(idx, 1);
        ctx.setState(nextState);
        ctx.saveState();
        renderLiveDraftTab(ctx);
      });
    });

    container.querySelectorAll('.edit-pick-btn').forEach((btn) => {
      btn.addEventListener('click', () => showEditPick(ctx, Number(btn.dataset.idx)));
    });
  }

  function showEditPick(ctx, pickIdx) {
    const { draft, state } = getDraftState(ctx);
    if (!draft.active || pickIdx < 0 || pickIdx >= draft.picks.length) return;
    const pick = draft.picks[pickIdx];
    const otherPickedIds = new Set(draft.picks.filter((_, idx) => idx !== pickIdx).map((item) => item.playerId));

    const renderList = (query = '') => state.players
      .filter((player) => !otherPickedIds.has(player.id))
      .filter((player) => !query || player.name.toLowerCase().includes(query))
      .slice(0, 120)
      .map((player) => `
        <div class="draft-player-row">
          <span class="draft-player-info">
            ${player.headshot ? `<img src="${player.headshot}" class="draft-headshot" loading="lazy" onerror="this.style.display='none'">` : '<div class="draft-headshot-ph"></div>'}
            <span class="draft-player-name">
              ${player.name}
              ${player.position ? `<span class="pos-badge pos-${player.position}">${player.position}</span>` : ''}
              ${player.ovr ? ctx.ovrBadge(player.ovr) : ''}
            </span>
          </span>
          <button class="btn btn-primary btn-sm ep-select-btn" data-pid="${player.id}">Select</button>
        </div>`).join('') || '<div class="text-dim text-sm" style="padding:12px">No players available</div>';

    ctx.showModal(`Edit Pick #${pickIdx + 1} — ${ctx.managerName(pick.managerId)}`, `
      <div class="text-xs text-muted mb-8">Current: <strong>${pick.playerName}</strong></div>
      <input type="text" id="ep-search" placeholder="Search players…" style="width:100%;margin-bottom:8px">
      <div id="ep-list" style="max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
        ${renderList('')}
      </div>
    `, null);

    const attach = () => {
      ctx.$('ep-list')?.querySelectorAll('.ep-select-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const playerId = Number(btn.dataset.pid);
          const nextState = structuredClone(ctx.getState());
          const livePick = nextState.liveDraft.picks[pickIdx];
          const oldPlayer = nextState.players.find((player) => player.id === livePick.playerId);
          const newPlayer = nextState.players.find((player) => player.id === playerId);
          if (!livePick || !newPlayer) return;
          if (oldPlayer && oldPlayer.teamCode === livePick.teamCode) oldPlayer.teamCode = '';
          livePick.playerId = newPlayer.id;
          livePick.playerName = newPlayer.name;
          livePick.position = newPlayer.position || '';
          newPlayer.teamCode = livePick.teamCode;
          ctx.setState(nextState);
          ctx.saveState();
          ctx.hideModal();
          ctx.toast(`Pick #${pickIdx + 1} updated → ${newPlayer.name}`, 'success');
          renderLiveDraftTab(ctx);
        });
      });
    };

    ctx.$('ep-search')?.addEventListener('input', (e) => {
      ctx.$('ep-list').innerHTML = renderList(e.target.value.toLowerCase());
      attach();
    });
    attach();
  }

  function autoDraftPick(ctx) {
    const { draft, onClockId, onClockTeam, currentIdx, isDone } = getDraftState(ctx);
    if (!draft.active || isDone || !onClockId) return;

    const picksForManager = draft.picks.filter((pick) => pick.managerId === onClockId);
    const counts = { F: 0, D: 0, G: 0 };
    picksForManager.forEach((pick) => {
      counts[ctx.posGroup(pick.position || '')]++;
    });

    const totalPerMgr = ctx.positionLimits.F + ctx.positionLimits.D + ctx.positionLimits.G;
    const currentCount = counts.F + counts.D + counts.G;
    const remaining = totalPerMgr - currentCount;
    const gNeeded = Math.max(0, ctx.positionLimits.G - counts.G);
    const dNeeded = Math.max(0, ctx.positionLimits.D - counts.D);
    const mustPickGoalie = remaining <= gNeeded && gNeeded > 0;
    const mustPickDefense = !mustPickGoalie && remaining <= (dNeeded + gNeeded) && dNeeded > 0;

    const pickedIds = new Set(draft.picks.map((pick) => pick.playerId));
    const players = ctx.getState().players;
    const managerQueue = draftUiState.queuedPlayerIdsByManager[onClockId] || [];
    const openGroups = ['F', 'D'].filter((group) => counts[group] < ctx.positionLimits[group]);

    const isValidQueuedPick = (player) => {
      if (!player || pickedIds.has(player.id)) return false;
      const group = ctx.posGroup(player.position || '');
      if (mustPickGoalie) return group === 'G';
      if (mustPickDefense) return group === 'D';
      if (group === 'G') return counts.G < ctx.positionLimits.G;
      return openGroups.includes(group);
    };

    let pick;
    pick = managerQueue
      .map((playerId) => players.find((player) => player.id === playerId))
      .find((player) => isValidQueuedPick(player));

    if (!pick && mustPickGoalie) {
      pick = players.filter((player) => !pickedIds.has(player.id) && ctx.posGroup(player.position || '') === 'G')
        .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
    } else if (!pick && mustPickDefense) {
      pick = players.filter((player) => !pickedIds.has(player.id) && ctx.posGroup(player.position || '') === 'D')
        .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
    } else if (!pick) {
      pick = players.filter((player) => !pickedIds.has(player.id) && openGroups.includes(ctx.posGroup(player.position || '')))
        .sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
    }

    if (!pick) {
      pick = players.filter((player) => !pickedIds.has(player.id)).sort((a, b) => (b.ovr || 0) - (a.ovr || 0))[0];
    }
    if (!pick) {
      ctx.toast('No players available to auto-pick', 'error');
      return;
    }

    const nextState = structuredClone(ctx.getState());
    const player = nextState.players.find((item) => item.id === pick.id);
    nextState.liveDraft.picks.push({
      round: Math.floor(currentIdx / draft.order.length) + 1,
      pick: currentIdx + 1,
      managerId: onClockId,
      teamCode: onClockTeam,
      playerId: pick.id,
      playerName: pick.name,
      position: pick.position || '',
    });
    if (player) player.teamCode = onClockTeam;
    ctx.setState(nextState);
    ctx.saveState();
    ctx.toast(`Auto-picked: ${pick.name} (${pick.ovr || '?'} OVR) → ${ctx.managerName(onClockId)}`, 'success');
    renderLiveDraftTab(ctx);
  }

  function showSetupLiveDraft(ctx) {
    const state = ctx.getState();
    if (!state.managers.length) { ctx.toast('Add managers in Settings first', 'error'); return; }
    if (!state.players.length) { ctx.toast('Fetch NHL rosters in Settings first', 'error'); return; }

    ctx.showModal('Setup Live Draft', `
      <div style="background:rgba(200,16,46,.08);border:1px solid rgba(200,16,46,.3);border-radius:6px;padding:14px 16px;margin-bottom:16px">
        <label style="font-size:.7rem;letter-spacing:1px;text-transform:uppercase;color:var(--text-muted);display:block;margin-bottom:6px">Number of Rounds</label>
        <input type="number" id="ld-rounds" value="${state.liveDraft?.rounds || 1}" min="1" max="30" style="font-size:1.4rem;font-weight:800;width:80px;text-align:center">
        <span class="text-xs text-muted" style="margin-left:10px">rounds × ${state.managers.length} managers = ${state.managers.length * (state.liveDraft?.rounds || 1)} total picks</span>
      </div>
      <div class="form-row">
        <label>Draft order (snake — set pick position for Round 1)</label>
        <p class="text-xs text-dim mb-8">Lower number = earlier pick</p>
        ${state.managers.map((manager, idx) => `
          <div class="flex gap-8 items-center mb-8">
            <span style="color:${manager.color};font-weight:700;min-width:80px">${manager.name}</span>
            <span class="text-xs text-muted">${ctx.teamBadge(ctx.getManagerTeam(manager.id))}</span>
            <input type="number" id="ld-order-${manager.id}" value="${idx + 1}" min="1" max="${state.managers.length}" style="width:60px;margin-left:auto">
          </div>`).join('')}
      </div>
      <button id="modal-ok" class="btn btn-primary btn-block mt-12">Start Draft</button>
    `, () => {
      const rounds = Math.max(1, Number(ctx.$('ld-rounds').value) || 1);
      const ordered = state.managers
        .map((manager) => ({ id: manager.id, pos: Number(ctx.$(`ld-order-${manager.id}`)?.value) || 99 }))
        .sort((a, b) => a.pos - b.pos)
        .map((item) => item.id);

      const nextState = structuredClone(ctx.getState());
      const prevAutoManagers = nextState.liveDraft?.autoManagers || [];
      nextState.liveDraft = { active: true, rounds, order: ordered, picks: [], autoManagers: prevAutoManagers };
      nextState.draftTab = 'live';
      ctx.setState(nextState);
      ctx.saveState();
      ctx.hideModal();
      renderDraft(ctx);
      ctx.toast('Draft started!', 'success');
    });
  }

  return {
    renderDraft,
    renderLiveDraftTab,
    showEditPick,
    autoDraftPick,
    showSetupLiveDraft,
  };
})();
