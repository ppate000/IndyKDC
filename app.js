(() => {
  'use strict';

  const DEFAULT_STATE = {
    teams: [
      { id: 1, name: 'Tigers', color: '#c6532f', icon: '🐯', score: 0, covered: false },
      { id: 2, name: 'Jaguars', color: '#4b368f', icon: '🐆', score: 0, covered: false },
      { id: 3, name: 'Parrots', color: '#137f6c', icon: '🦜', score: 0, covered: false },
      { id: 4, name: 'Gorillas', color: '#38628a', icon: '🦍', score: 0, covered: false },
      { id: 5, name: 'Lizard', color: '#547f2b', icon: '🦎', score: 0, covered: false },
      { id: 6, name: 'Elephants', color: '#9b5d2e', icon: '🐘', score: 0, covered: false }
    ],
    timer: { duration: 1200, remaining: 1200, running: false, hidden: false, endAt: null },
    rotation: 'Half 1',
    rankingsHidden: false,
    history: [],
    soundEnabled: true,
    lastLeaderId: null
  };

  const CELEBRATION_ASSETS = {
    1: 'assets/celebrations/tiger.gif',
    2: 'assets/celebrations/jaguar.webp',
    3: 'assets/celebrations/parrot.gif',
    4: 'assets/celebrations/gorilla.gif',
    5: 'assets/celebrations/lizard.webp',
    6: 'assets/celebrations/elephant.gif'
  };

  const CONFIG = window.JUNGLE_CONFIG || {};
  const isConfigured = Boolean(
    CONFIG.supabaseUrl &&
    CONFIG.supabasePublishableKey &&
    !CONFIG.supabaseUrl.includes('YOUR_') &&
    !CONFIG.supabasePublishableKey.includes('YOUR_')
  );

  const db = isConfigured && window.supabase
    ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabasePublishableKey)
    : null;

  let state = loadCachedState();
  let timerHandle = null;
  let adminUnlocked = false;
  let currentUser = null;
  let realtimeChannel = null;
  let cloudReady = false;
  let suppressCloudSave = false;
  let pollHandle = null;
  let reconnectHandle = null;
  let saveChain = Promise.resolve();
  let lastRemoteUpdatedAt = null;
  const cardPositions = new Map();

  const els = {
    app: document.getElementById('app'), leaderboard: document.getElementById('leaderboard'),
    timerDisplay: document.getElementById('timerDisplay'), timerHidden: document.getElementById('timerHidden'),
    timerStatus: document.getElementById('timerStatus'), leaderName: document.getElementById('leaderName'),
    leaderScore: document.getElementById('leaderScore'), leaderCallout: document.querySelector('.leader-callout'), rotationDisplay: document.getElementById('rotationDisplay'),
    rankingsHiddenBanner: document.getElementById('rankingsHiddenBanner'), adminPanel: document.getElementById('adminPanel'),
    loginDialog: document.getElementById('loginDialog'), emailInput: document.getElementById('emailInput'),
    passwordInput: document.getElementById('passwordInput'), loginError: document.getElementById('loginError'),
    teamControls: document.getElementById('teamControls'), historyList: document.getElementById('historyList'),
    teamSettings: document.getElementById('teamSettings'), activityAlert: document.getElementById('activityAlert'),
    hideTimerToggle: document.getElementById('hideTimerToggle'), toggleRankingsBtn: document.getElementById('toggleRankingsBtn'),
    soundToggle: document.getElementById('soundToggle'), saveStatus: document.getElementById('saveStatus'),
    adminIdentity: document.getElementById('adminIdentity'), connectionStatus: document.getElementById('connectionStatus')
  };

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function normalizeState(value) {
    const incoming = value && typeof value === 'object' ? value : {};
    const merged = {
      ...clone(DEFAULT_STATE),
      ...incoming,
      teams: Array.isArray(incoming.teams) ? incoming.teams : clone(DEFAULT_STATE.teams),
      timer: { ...DEFAULT_STATE.timer, ...(incoming.timer || {}) },
      history: Array.isArray(incoming.history) ? incoming.history : []
    };
    // Migrate the original Crocodiles team to Lizard without overwriting later custom names.
    const lizardTeam = merged.teams.find(team => Number(team.id) === 5);
    if (lizardTeam && (lizardTeam.name === 'Crocodiles' || lizardTeam.name === 'Crocodile')) {
      lizardTeam.name = 'Lizard';
      lizardTeam.icon = '🦎';
    }
    delete merged.password;
    return merged;
  }

  function loadCachedState() {
    try {
      return normalizeState(JSON.parse(localStorage.getItem('jungleLeaderboardState')));
    } catch {
      return clone(DEFAULT_STATE);
    }
  }

  function cacheState() {
    localStorage.setItem('jungleLeaderboardState', JSON.stringify(state));
  }

  function saveState() {
    cacheState();
    if (suppressCloudSave) return Promise.resolve();
    if (!db || !cloudReady) {
      els.saveStatus.textContent = isConfigured ? 'Connecting…' : 'Local mode — configure Supabase';
      return Promise.resolve();
    }
    if (!adminUnlocked || !currentUser) {
      els.saveStatus.textContent = 'Live viewer';
      return Promise.resolve();
    }

    // Serialize saves so rapid +1/+5 clicks cannot arrive out of order.
    const payload = clone(state);
    delete payload.password;
    saveChain = saveChain.then(async () => {
      els.saveStatus.textContent = 'Saving…';
      const { data, error } = await db.rpc('save_leaderboard_state', { p_state: payload });
      if (error) {
        console.error('Supabase save failed:', error);
        els.saveStatus.textContent = 'SAVE FAILED';
        setConnectionStatus('Save blocked', false);
        toast(`Could not save to Supabase: ${error.message}`, 'warning');
        throw error;
      }
      if (!data || typeof data !== 'object') {
        const err = new Error('Supabase did not return the saved leaderboard state.');
        console.error(err);
        els.saveStatus.textContent = 'SAVE FAILED';
        toast(err.message, 'warning');
        throw err;
      }
      els.saveStatus.textContent = 'Live • saved';
      setConnectionStatus('Live', true);
    }).catch(() => {});
    return saveChain;
  }

  async function initializeCloud() {
    if (!db) {
      setConnectionStatus('Local mode', false);
      renderAll({ animate: false, persist: false });
      return;
    }

    setConnectionStatus('Connecting…', false);

    const { data: authData } = await db.auth.getSession();
    if (authData?.session?.user) setSignedInUser(authData.session.user);

    db.auth.onAuthStateChange((_event, session) => {
      if (session?.user) setSignedInUser(session.user);
      else setSignedOut();
    });

    const { data, error } = await db.from('app_state').select('state, updated_at').eq('id', 1).single();
    if (error) {
      console.error(error);
      setConnectionStatus('Cloud error', false);
      els.saveStatus.textContent = 'Could not load shared state';
      toast('Supabase is configured, but the shared state could not be loaded. Run schema.sql in Supabase.', 'warning');
      return;
    }

    cloudReady = true;
    lastRemoteUpdatedAt = data.updated_at || null;
    applyRemoteState(data.state, false);
    setConnectionStatus('Live', true);
    els.saveStatus.textContent = adminUnlocked ? 'Live • synced' : 'Live viewer';
    subscribeToSharedState();
    startFallbackPolling();
  }

  function subscribeToSharedState() {
    if (!db) return;
    if (realtimeChannel) {
      try { db.removeChannel(realtimeChannel); } catch {}
      realtimeChannel = null;
    }
    realtimeChannel = db
      .channel(`jungle-leaderboard-live-${Date.now()}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'app_state', filter: 'id=eq.1'
      }, payload => {
        if (payload.new?.updated_at) lastRemoteUpdatedAt = payload.new.updated_at;
        if (payload.new?.state) applyRemoteState(payload.new.state, true);
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          setConnectionStatus('Live', true);
          if (reconnectHandle) { clearTimeout(reconnectHandle); reconnectHandle = null; }
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnectionStatus('Realtime reconnecting…', false);
          if (!reconnectHandle) {
            reconnectHandle = setTimeout(() => {
              reconnectHandle = null;
              subscribeToSharedState();
            }, 2000);
          }
        }
      });
  }

  function startFallbackPolling() {
    clearInterval(pollHandle);
    if (!db) return;
    pollHandle = setInterval(fetchLatestSharedState, 2000);
  }

  async function fetchLatestSharedState() {
    if (!db || !cloudReady || suppressCloudSave) return;
    const { data, error } = await db
      .from('app_state')
      .select('state, updated_at')
      .eq('id', 1)
      .single();
    if (error || !data) {
      if (error) console.warn('Fallback sync failed:', error.message);
      return;
    }
    if (data.updated_at && data.updated_at !== lastRemoteUpdatedAt) {
      lastRemoteUpdatedAt = data.updated_at;
      applyRemoteState(data.state, true);
    }
  }

  function applyRemoteState(remoteState, animateChanges = true) {
    const previous = clone(state);
    suppressCloudSave = true;
    state = normalizeState(remoteState);
    cacheState();
    renderAll({ animate: animateChanges, persist: false });

    if (state.timer.running) runTimerLoop();
    else stopTimerLoop();

    if (animateChanges) {
      state.teams.forEach(team => {
        const oldTeam = previous.teams.find(t => t.id === team.id);
        if (oldTeam && oldTeam.score !== team.score) {
          requestAnimationFrame(() => animateScore(team.id, oldTeam.score, team.score, team.score - oldTeam.score));
          if (team.score > oldTeam.score) playTone('point');
        }
      });
      const oldLeader = getLeaderId(previous.teams);
      const newLeader = getLeaderId(state.teams);
      if (newLeader && oldLeader && newLeader !== oldLeader) setTimeout(() => celebrateLeader(newLeader), 100);
    }
    suppressCloudSave = false;
  }

  function setConnectionStatus(text, connected) {
    if (!els.connectionStatus) return;
    els.connectionStatus.textContent = text;
    els.connectionStatus.classList.toggle('connected', Boolean(connected));
  }

  function setSignedInUser(user) {
    currentUser = user;
    adminUnlocked = true;
    if (els.adminIdentity) els.adminIdentity.textContent = user.email || 'Authenticated admin';
    document.getElementById('adminUnlockBtn').textContent = '🔓 Admin';
  }

  function setSignedOut() {
    currentUser = null;
    adminUnlocked = false;
    closeAdmin();
    if (els.adminIdentity) els.adminIdentity.textContent = 'Not signed in';
    document.getElementById('adminUnlockBtn').textContent = '🔒 Admin';
    if (cloudReady) els.saveStatus.textContent = 'Live viewer';
  }

  function sortedTeams(teams = state.teams) {
    return [...teams].sort((a, b) => b.score - a.score || a.id - b.id);
  }

  function getLeaderId(teams) {
    const sorted = sortedTeams(teams);
    if (!sorted[0] || sorted[0].score <= 0) return null;
    return sorted[0].id;
  }

  function rankLabel(i) {
    const n = i + 1;
    return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
  }

  function renderAll({ animate = true, persist = true } = {}) {
    renderLeaderboard(animate);
    renderTimer();
    renderHeader();
    renderAdminControls();
    renderHistory();
    renderSettings();
    checkSuspiciousActivity();
    if (persist) void saveState();
  }

  function renderHeader() {
    els.rotationDisplay.textContent = state.rotation;
    const leaderHidden = state.rankingsHidden || state.teams.some(team => team.covered);
    if (els.leaderCallout) els.leaderCallout.classList.toggle('leader-concealed', leaderHidden);

    if (leaderHidden) {
      els.leaderName.textContent = 'Leader Hidden';
      els.leaderScore.textContent = '—';
    } else {
      const sorted = sortedTeams();
      const leader = sorted[0];
      const tied = sorted.length > 1 && leader.score === sorted[1].score;
      if (!leader || leader.score === 0) {
        els.leaderName.textContent = 'Waiting for points';
        els.leaderScore.textContent = '—';
      } else if (tied) {
        els.leaderName.textContent = 'It’s a tie!';
        els.leaderScore.textContent = `${leader.score} points`;
      } else {
        els.leaderName.textContent = `${leader.icon} ${leader.name}`;
        els.leaderScore.textContent = `${leader.score} points`;
      }
    }
    els.soundToggle.textContent = state.soundEnabled ? '🔊' : '🔇';
  }

  function renderLeaderboard(animate = true) {
    const teams = sortedTeams();
    cardPositions.clear();
    document.querySelectorAll('.team-card').forEach(card => cardPositions.set(Number(card.dataset.id), card.getBoundingClientRect()));

    els.leaderboard.innerHTML = '';
    els.rankingsHiddenBanner.classList.toggle('hidden', !state.rankingsHidden);
    els.leaderboard.classList.toggle('hidden', state.rankingsHidden);

    teams.forEach((team, index) => {
      const node = document.getElementById('teamCardTemplate').content.firstElementChild.cloneNode(true);
      node.dataset.id = team.id;
      node.style.background = `linear-gradient(120deg, ${team.color}, color-mix(in srgb, ${team.color} 62%, #061b13))`;
      node.classList.toggle('first-place', index === 0 && team.score > 0);
      node.classList.toggle('covered', team.covered);
      node.querySelector('.rank-badge').textContent = rankLabel(index);
      node.querySelector('.team-icon-base').textContent = team.icon;
      node.querySelector('.team-name').textContent = team.name;
      node.querySelector('.score').textContent = team.score;
      const reaction = node.querySelector('.mascot-reaction');
      reaction.src = CELEBRATION_ASSETS[team.id] || '';
      reaction.alt = '';
      reaction.hidden = !reaction.src;
      els.leaderboard.appendChild(node);
    });

    if (animate) {
      requestAnimationFrame(() => {
        document.querySelectorAll('.team-card').forEach(card => {
          const old = cardPositions.get(Number(card.dataset.id));
          if (!old) return;
          const now = card.getBoundingClientRect();
          const dy = old.top - now.top;
          if (Math.abs(dy) > 2) {
            card.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 650, easing: 'cubic-bezier(.2,.8,.2,1)' });
          }
        });
      });
    }
    state.lastLeaderId = getLeaderId(state.teams);
  }

  function animateScore(teamId, oldScore, newScore, delta) {
    const card = document.querySelector(`.team-card[data-id="${teamId}"]`);
    if (!card) return;
    const scoreEl = card.querySelector('.score');
    const duration = 650;
    const start = performance.now();
    const step = now => {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      scoreEl.textContent = Math.round(oldScore + (newScore - oldScore) * eased);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    const float = card.querySelector('.point-float');
    float.textContent = `${delta > 0 ? '+' : ''}${delta}`;
    float.classList.remove('animate');
    void float.offsetWidth;
    float.classList.add('animate');
    card.classList.add('earned');
    setTimeout(() => card.classList.remove('earned'), 2200);
    // Intentionally no leaf/particle burst. Keep score float + mascot pop only.
  }



  function requireAdmin() {
    if (adminUnlocked && currentUser) return true;
    toast('Sign in as an admin to change the shared leaderboard.', 'warning');
    if (db) els.loginDialog.showModal();
    return false;
  }

  function addPoints(teamId, amount, admin = currentUser?.email || 'Admin') {
    if (!requireAdmin()) return;
    const team = state.teams.find(t => t.id === teamId);
    if (!team || !Number.isFinite(amount) || amount === 0) return;
    const oldScore = team.score;
    team.score = Math.max(0, team.score + amount);
    const actualDelta = team.score - oldScore;
    if (actualDelta === 0) return;
    state.history.unshift({ id: crypto.randomUUID?.() || String(Date.now()+Math.random()), timestamp: Date.now(), teamId, teamName: team.name, action: actualDelta, admin });
    if (state.history.length > 300) state.history.length = 300;
    const previousLeader = state.lastLeaderId;
    renderAll();
    requestAnimationFrame(() => animateScore(teamId, oldScore, team.score, actualDelta));
    if (actualDelta > 0) playTone('point');
    if (previousLeader !== state.lastLeaderId && state.lastLeaderId === teamId) setTimeout(() => celebrateLeader(teamId), 80);
  }

  function undoLast() {
    if (!requireAdmin()) return;
    const last = state.history.shift();
    if (!last) return toast('Nothing to undo.');
    const team = state.teams.find(t => t.id === last.teamId);
    if (team) team.score = Math.max(0, team.score - last.action);
    toast(`Undid ${last.action > 0 ? '+' : ''}${last.action} for ${last.teamName}.`, 'success');
    renderAll();
  }

  function currentRemaining() {
    if (!state.timer.running || !state.timer.endAt) return Math.max(0, Math.round(Number(state.timer.remaining) || 0));
    return Math.max(0, Math.ceil((Number(state.timer.endAt) - Date.now()) / 1000));
  }

  function renderTimer() {
    const remaining = currentRemaining();
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    els.timerDisplay.textContent = `${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    els.timerDisplay.classList.toggle('hidden', state.timer.hidden);
    els.timerHidden.classList.toggle('hidden', !state.timer.hidden);
    els.timerStatus.textContent = remaining === 0 ? 'Time is up!' : state.timer.running ? 'Running' : remaining === state.timer.duration ? 'Ready' : 'Paused';
    els.hideTimerToggle.checked = state.timer.hidden;
  }

  function startTimer() {
    if (!requireAdmin()) return;
    let remaining = currentRemaining();
    if (remaining <= 0) remaining = state.timer.duration;
    state.timer.remaining = remaining;
    state.timer.running = true;
    state.timer.endAt = Date.now() + remaining * 1000;
    runTimerLoop(); renderTimer(); void saveState();
  }

  function pauseTimer() {
    if (!requireAdmin()) return;
    state.timer.remaining = currentRemaining();
    state.timer.running = false;
    state.timer.endAt = null;
    stopTimerLoop(); renderTimer(); void saveState();
  }

  function stopTimerLoop() {
    clearInterval(timerHandle);
    timerHandle = null;
  }

  function runTimerLoop() {
    stopTimerLoop();
    if (!state.timer.running) return;
    timerHandle = setInterval(() => {
      const remaining = currentRemaining();
      renderTimer();
      if (remaining <= 10 && remaining > 0 && state.soundEnabled) playTone('tick');
      if (remaining <= 0) {
        stopTimerLoop();
        if (adminUnlocked && currentUser) {
          state.timer.remaining = 0;
          state.timer.running = false;
          state.timer.endAt = null;
          void saveState();
          playTone('finish');
          toast('Time is up!', 'warning');
        }
      }
    }, 1000);
  }

  function renderAdminControls() {
    els.teamControls.innerHTML = state.teams.map(team => `
      <div class="team-control-card" style="--team-color:${team.color}">
        <div class="team-control-top"><strong>${team.icon} ${escapeHtml(team.name)}</strong><span>${team.score} pts</span></div>
        <div class="quick-points">
          ${[1,3,5,10].map(n=>`<button type="button" data-team="${team.id}" data-points="${n}">+${n}</button>`).join('')}
          <button type="button" data-team="${team.id}" data-points="-1">−1</button>
        </div>
        <div class="custom-row">
          <input type="number" placeholder="Custom" data-custom-input="${team.id}" />
          <button class="add-custom" data-custom-add="${team.id}" type="button">Add</button>
          <button class="subtract-custom" data-custom-sub="${team.id}" type="button">Remove</button>
        </div>
      </div>`).join('');
    els.toggleRankingsBtn.textContent = state.rankingsHidden ? 'Show Rankings' : 'Hide Rankings';
    document.querySelectorAll('[data-rotation]').forEach(b => b.classList.toggle('active', b.dataset.rotation === state.rotation));
  }

  function renderHistory() {
    if (!state.history.length) {
      els.historyList.innerHTML = '<div class="history-item"><span>—</span><span>No activity yet</span><span></span></div>';
      return;
    }
    els.historyList.innerHTML = state.history.slice(0,80).map(item => {
      const time = new Date(item.timestamp).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
      return `<div class="history-item"><span class="history-time">${time}</span><span>${escapeHtml(item.teamName)} <span class="history-admin">by ${escapeHtml(item.admin || 'Admin')}</span></span><span class="history-action">${item.action > 0 ? '+' : ''}${item.action}</span></div>`;
    }).join('');
  }

  function renderSettings() {
    els.teamSettings.innerHTML = state.teams.map(team => `
      <div class="team-setting-row">
        <input type="color" data-setting-color="${team.id}" value="${team.color}" title="Team color" />
        <input type="text" data-setting-name="${team.id}" value="${escapeAttr(team.name)}" aria-label="Team name" />
        <input class="logo-input" type="text" maxlength="4" data-setting-icon="${team.id}" value="${escapeAttr(team.icon)}" aria-label="Team icon" />
        <button type="button" class="secondary-btn" data-save-team="${team.id}">✓</button>
      </div>`).join('');
  }

  function checkSuspiciousActivity() {
    const cutoff = Date.now() - 60000;
    const recent = state.history.filter(h => h.timestamp >= cutoff);
    const suspicious = [];
    for (const team of state.teams) {
      const actions = recent.filter(h => h.teamId === team.id);
      const absolute = actions.reduce((s,h)=>s+Math.abs(h.action),0);
      if (actions.length >= 5 || absolute >= 25) suspicious.push(`${team.name}: ${actions.length} changes / ${absolute} points in 1 minute`);
    }
    const huge = recent.find(h => Math.abs(h.action) >= 20);
    if (huge) suspicious.push(`${huge.teamName}: unusually large ${huge.action > 0 ? '+' : ''}${huge.action} adjustment`);
    els.activityAlert.classList.toggle('hidden', suspicious.length === 0);
    els.activityAlert.innerHTML = suspicious.length ? `⚠️ <strong>Suspicious activity</strong><br>${[...new Set(suspicious)].join('<br>')}` : '';
  }

  function celebrateLeader(teamId) {
    const card = document.querySelector(`.team-card[data-id="${teamId}"]`);
    if (card) card.animate([{filter:'brightness(1)'},{filter:'brightness(1.45)'},{filter:'brightness(1)'}],{duration:1200});
    confetti();
    playTone(['roar','drums','trumpet'][Math.floor(Math.random()*3)]);
  }

  function confetti() {
    const colors = ['#ffd768','#ffffff','#66cc7a','#ff725f','#69a7ff','#b789ff'];
    for (let i=0;i<80;i++) {
      const p=document.createElement('span'); p.className='confetti-piece';
      p.style.left=`${Math.random()*100}%`; p.style.background=colors[Math.floor(Math.random()*colors.length)];
      p.style.setProperty('--drift',`${-130+Math.random()*260}px`); p.style.animationDelay=`${Math.random()*.45}s`;
      document.getElementById('confettiLayer').appendChild(p); setTimeout(()=>p.remove(),3400);
    }
  }

  function playTone(type) {
    if (!state.soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const gain = ctx.createGain(); gain.connect(ctx.destination); gain.gain.setValueAtTime(.001, now);
      gain.gain.exponentialRampToValueAtTime(.16, now+.02); gain.gain.exponentialRampToValueAtTime(.001, now+1.2);
      const notes = type==='point'?[440,660]:type==='tick'?[180]:type==='finish'?[300,240,180]:type==='trumpet'?[392,523,659]:type==='drums'?[100,80,120]:[90,70,55];
      notes.forEach((freq,i)=>{ const o=ctx.createOscillator(); o.type=type==='drums'||type==='roar'?'sawtooth':'triangle'; o.frequency.setValueAtTime(freq,now+i*.14); if(type==='roar')o.frequency.exponentialRampToValueAtTime(freq*.55,now+.55); o.connect(gain); o.start(now+i*.14); o.stop(now+.7+i*.14); });
      setTimeout(()=>ctx.close(),1500);
    } catch {}
  }

  function toast(message, type='') {
    const t=document.createElement('div');t.className=`toast ${type}`;t.textContent=message;document.getElementById('toastContainer').appendChild(t);setTimeout(()=>t.remove(),3500);
  }

  function coverAll() { if (!requireAdmin()) return; state.teams.forEach(t=>t.covered=true); renderAll(); }
  function revealNext() {
    if (!requireAdmin()) return;
    const covered = sortedTeams().filter(t=>t.covered);
    if (!covered.length) return toast('All teams are already revealed.');
    covered[covered.length - 1].covered = false;
    playTone('drums'); renderAll();
  }
  function revealAll() { if (!requireAdmin()) return; state.teams.forEach(t=>t.covered=false); playTone('trumpet'); renderAll(); }

  function revealTeam(teamId) {
    if (!requireAdmin()) return;
    const team = state.teams.find(t => t.id === teamId);
    if (!team || !team.covered) return;
    team.covered = false;
    playTone('drums');
    renderAll();
  }

  function bindEvents() {
    document.getElementById('loginCloseBtn').addEventListener('click',()=> els.loginDialog.close());

    document.getElementById('adminUnlockBtn').addEventListener('click',()=> {
      if (!db) return toast('Add your Supabase URL and publishable key in config.js first.', 'warning');
      adminUnlocked ? openAdmin() : els.loginDialog.showModal();
    });

    document.getElementById('loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      if (!db) return;
      els.loginError.classList.add('hidden');
      const button = e.currentTarget.querySelector('.primary-btn');
      button.disabled = true;
      button.textContent = 'Signing in…';
      const { data, error } = await db.auth.signInWithPassword({ email: els.emailInput.value.trim(), password: els.passwordInput.value });
      button.disabled = false;
      button.textContent = 'Unlock Controls';
      if (error || !data.user) {
        els.loginError.textContent = error?.message || 'Could not sign in.';
        els.loginError.classList.remove('hidden');
        playTone('tick');
        return;
      }
      setSignedInUser(data.user);
      els.loginDialog.close();
      els.passwordInput.value='';
      openAdmin();
    });

    document.getElementById('closeAdminBtn').addEventListener('click',closeAdmin);
    document.getElementById('lockAdminBtn').addEventListener('click', async()=>{
      if (db) await db.auth.signOut();
      setSignedOut();
      toast('Admin signed out.');
    });
    document.getElementById('fullscreenBtn').addEventListener('click',()=> document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
    els.soundToggle.addEventListener('click',()=>{state.soundEnabled=!state.soundEnabled;renderHeader();cacheState();});
    els.rotationDisplay.addEventListener('click',()=>{ if(adminUnlocked && requireAdmin()){state.rotation=state.rotation==='Half 1'?'Half 2':'Half 1';renderAll();} });

    document.querySelectorAll('[data-timer]').forEach(btn=>btn.addEventListener('click',()=>{
      const action=btn.dataset.timer;
      if(action==='start'||action==='resume') startTimer();
      if(action==='pause') pauseTimer();
      if(action==='reset'){
        if (!requireAdmin()) return;
        stopTimerLoop(); state.timer.running=false; state.timer.endAt=null; state.timer.remaining=state.timer.duration; renderTimer(); void saveState();
      }
      if(action==='add60'){
        if (!requireAdmin()) return;
        const next=currentRemaining()+60; state.timer.remaining=next; if(state.timer.running) state.timer.endAt=Date.now()+next*1000; renderTimer(); void saveState();
      }
      if(action==='sub60'){
        if (!requireAdmin()) return;
        const next=Math.max(0,currentRemaining()-60); state.timer.remaining=next; if(state.timer.running) state.timer.endAt=Date.now()+next*1000; renderTimer(); void saveState();
      }
    }));

    document.getElementById('setTimerBtn').addEventListener('click',()=>{
      if (!requireAdmin()) return;
      const m=Math.max(0,Number(document.getElementById('timerMinutesInput').value)||0);
      const s=Math.min(59,Math.max(0,Number(document.getElementById('timerSecondsInput').value)||0));
      stopTimerLoop(); state.timer.running=false; state.timer.endAt=null; state.timer.duration=m*60+s; state.timer.remaining=state.timer.duration; renderTimer();void saveState();toast('Timer updated.','success');
    });
    els.hideTimerToggle.addEventListener('change',()=>{if(!requireAdmin()){els.hideTimerToggle.checked=state.timer.hidden;return;}state.timer.hidden=els.hideTimerToggle.checked;renderTimer();void saveState();});
    els.toggleRankingsBtn.addEventListener('click',()=>{if(!requireAdmin())return;state.rankingsHidden=!state.rankingsHidden;renderAll();});
    document.getElementById('coverAllBtn').addEventListener('click',coverAll);
    document.getElementById('revealNextBtn').addEventListener('click',revealNext);
    document.getElementById('revealAllBtn').addEventListener('click',revealAll);
    document.getElementById('undoBtn').addEventListener('click',undoLast);

    document.addEventListener('click',e=>{
      const coveredCard = e.target.closest('.team-card.covered');
      if (coveredCard) {
        revealTeam(Number(coveredCard.dataset.id));
        return;
      }
      const p=e.target.closest('[data-points]'); if(p) addPoints(Number(p.dataset.team),Number(p.dataset.points));
      const add=e.target.closest('[data-custom-add]'); if(add){const id=Number(add.dataset.customAdd);const input=document.querySelector(`[data-custom-input="${id}"]`);addPoints(id,Math.abs(Number(input.value)||0));input.value='';}
      const sub=e.target.closest('[data-custom-sub]'); if(sub){const id=Number(sub.dataset.customSub);const input=document.querySelector(`[data-custom-input="${id}"]`);addPoints(id,-Math.abs(Number(input.value)||0));input.value='';}
      const rot=e.target.closest('[data-rotation]'); if(rot){if(!requireAdmin())return;state.rotation=rot.dataset.rotation;renderAll();}
      const save=e.target.closest('[data-save-team]'); if(save){
        if(!requireAdmin())return;
        const id=Number(save.dataset.saveTeam), team=state.teams.find(t=>t.id===id);
        team.name=document.querySelector(`[data-setting-name="${id}"]`).value.trim()||team.name;
        team.color=document.querySelector(`[data-setting-color="${id}"]`).value;
        team.icon=document.querySelector(`[data-setting-icon="${id}"]`).value.trim()||team.icon;
        state.history.forEach(h=>{if(h.teamId===id)h.teamName=team.name;}); renderAll();toast('Team updated.','success');
      }
    });

    document.getElementById('clearLogBtn').addEventListener('click',()=>{if(!requireAdmin())return;if(confirm('Clear the complete activity history?')){state.history=[];renderAll();}});
    document.getElementById('changePasswordBtn').addEventListener('click',async()=>{
      if(!requireAdmin() || !db)return;
      const input=document.getElementById('newPasswordInput'); if(input.value.length<8)return toast('Password must be at least 8 characters.','warning');
      const {error}=await db.auth.updateUser({password:input.value});
      if(error)return toast(error.message,'warning');
      input.value='';toast('Admin password updated.','success');
    });
    document.getElementById('resetAllBtn').addEventListener('click',()=>{
      if(!requireAdmin())return;
      if(confirm('Reset scores, teams, timer, settings, and history?')){state=clone(DEFAULT_STATE);stopTimerLoop();renderAll();toast('Leaderboard reset.','success');}
    });
  }

  function openAdmin(){els.adminPanel.classList.add('open');els.adminPanel.setAttribute('aria-hidden','false');}
  function closeAdmin(){els.adminPanel.classList.remove('open');els.adminPanel.setAttribute('aria-hidden','true');}
  function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  function escapeAttr(s){return escapeHtml(s);}
  function setTimeTheme(){const h=new Date().getHours();els.app.classList.remove('time-morning','time-afternoon','time-sunset','time-night');els.app.classList.add(h<12?'time-morning':h<17?'time-afternoon':h<20?'time-sunset':'time-night');}

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void fetchLatestSharedState();
  });

  bindEvents();
  setTimeTheme();
  renderAll({animate:false, persist:false});
  if(state.timer.running) runTimerLoop();
  void initializeCloud();
})();
