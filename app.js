(() => {
  const DEFAULT_STATE = {
    teams: [
      { id: "team1", name: "Team 1", score: 0 },
      { id: "team2", name: "Team 2", score: 0 },
      { id: "team3", name: "Team 3", score: 0 },
      { id: "team4", name: "Team 4", score: 0 },
      { id: "team5", name: "Team 5", score: 0 },
      { id: "team6", name: "Team 6", score: 0 }
    ],
    standingsHidden: false,
    revealedPlacements: [],
    timerVisible: false,
    timerEndsAt: null
  };

  const cfg = window.JYOTARA_CONFIG || {};
  const configReady =
    cfg.supabaseUrl &&
    cfg.supabaseAnonKey &&
    !cfg.supabaseUrl.includes("YOUR_") &&
    !cfg.supabaseAnonKey.includes("YOUR_");

  const leaderboardEl = document.getElementById("leaderboard");
  const connectionStatus = document.getElementById("connectionStatus");
  const adminDialog = document.getElementById("adminDialog");
  const loginSection = document.getElementById("loginSection");
  const adminSection = document.getElementById("adminSection");
  const teamControls = document.getElementById("teamControls");
  const timerWrap = document.getElementById("timerWrap");
  const timerDisplay = document.getElementById("timerDisplay");
  const loginMessage = document.getElementById("loginMessage");

  let supabase = null;
  let state = structuredClone(DEFAULT_STATE);
  let isAdmin = false;
  let lastLeaderId = null;
  let hasLoadedInitialState = false;
  let realtimeChannel = null;

  function normalizeState(raw) {
    const next = { ...structuredClone(DEFAULT_STATE), ...(raw || {}) };
    next.teams = Array.isArray(raw?.teams) && raw.teams.length === 6
      ? raw.teams.map((t, i) => ({
          id: t.id || `team${i + 1}`,
          name: t.name || `Team ${i + 1}`,
          score: Number(t.score) || 0
        }))
      : structuredClone(DEFAULT_STATE.teams);
    next.revealedPlacements = Array.isArray(raw?.revealedPlacements)
      ? raw.revealedPlacements.map(Number).filter(n => n >= 1 && n <= 6)
      : [];
    next.standingsHidden = Boolean(raw?.standingsHidden);
    next.timerVisible = Boolean(raw?.timerVisible);
    next.timerEndsAt = raw?.timerEndsAt || null;
    return next;
  }

  function rankedTeams() {
    return [...state.teams].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id);
    });
  }

  function leaderId() {
    return rankedTeams()[0]?.id || null;
  }

  function renderLeaderboard() {
    const ranked = rankedTeams();
    leaderboardEl.innerHTML = "";
    document.body.classList.toggle("admin-active", isAdmin);

    ranked.forEach((team, index) => {
      const placement = index + 1;
      const hidden = state.standingsHidden && !state.revealedPlacements.includes(placement);

      const card = document.createElement("article");
      card.className = `rank-card ${placement === 1 ? "first" : ""} ${hidden ? "hidden-card" : ""}`;
      card.dataset.placement = String(placement);

      card.innerHTML = `
        <div class="rank">${placement}</div>
        <div>
          <div class="team-name">${escapeHtml(team.name)}</div>
          <div class="team-sub">Current standing</div>
        </div>
        <div class="score">${team.score}</div>
        ${hidden ? `<div class="hidden-label">${isAdmin ? "CLICK TO REVEAL" : "HIDDEN"}</div>` : ""}
      `;

      if (hidden && isAdmin) {
        card.addEventListener("click", () => revealPlacement(placement));
      }

      leaderboardEl.appendChild(card);
    });

    renderTeamControls();
    timerWrap.classList.toggle("hidden", !state.timerVisible);
  }

  function renderTeamControls() {
    if (!isAdmin) return;
    teamControls.innerHTML = "";
    state.teams.forEach(team => {
      const box = document.createElement("div");
      box.className = "team-control";
      box.innerHTML = `
        <div class="team-control-head">
          <div class="team-control-title">${escapeHtml(team.name)}</div>
          <div class="team-control-score">${team.score} pts</div>
        </div>
        <div class="point-buttons">
          <button type="button" class="minus" data-delta="-5">−5</button>
          <button type="button" class="minus" data-delta="-1">−1</button>
          <button type="button" class="plus" data-delta="1">+1</button>
          <button type="button" class="plus" data-delta="5">+5</button>
          <button type="button" class="plus" data-delta="10">+10</button>
        </div>
      `;
      box.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", () => changeScore(team.id, Number(btn.dataset.delta)));
      });
      teamControls.appendChild(box);
    });
  }

  async function saveState(nextState) {
    if (!supabase || !isAdmin) return;
    state = normalizeState(nextState);
    renderLeaderboard();

    const { error } = await supabase
      .from("leaderboard_state")
      .update({
        state,
        updated_at: new Date().toISOString()
      })
      .eq("id", 1);

    if (error) {
      console.error(error);
      connectionStatus.textContent = `Update failed: ${error.message}`;
      await loadState();
    }
  }

  async function changeScore(teamId, delta) {
    const next = structuredClone(state);
    const team = next.teams.find(t => t.id === teamId);
    if (!team) return;
    team.score += delta;
    await saveState(next);
  }

  async function revealPlacement(placement) {
    if (!isAdmin || !state.standingsHidden) return;
    const next = structuredClone(state);
    if (!next.revealedPlacements.includes(placement)) {
      next.revealedPlacements.push(placement);
      next.revealedPlacements.sort((a, b) => a - b);
      await saveState(next);
    }
  }

  function maybeCelebrate(newState) {
    const oldLeader = lastLeaderId;
    state = normalizeState(newState);
    const newLeader = leaderId();

    if (hasLoadedInitialState && oldLeader && newLeader && newLeader !== oldLeader) {
      const winner = state.teams.find(t => t.id === newLeader);
      showCelebration(winner?.name || "New Leader");
    }

    lastLeaderId = newLeader;
    hasLoadedInitialState = true;
  }

  function showCelebration(teamName) {
    const wrap = document.getElementById("celebration");
    document.getElementById("celebrationTeam").textContent = teamName;
    const sparkles = document.getElementById("sparkles");
    sparkles.innerHTML = "";

    for (let i = 0; i < 34; i++) {
      const s = document.createElement("span");
      s.className = "spark";
      const angle = (Math.PI * 2 * i) / 34 + Math.random() * .2;
      const distance = 120 + Math.random() * 310;
      s.style.left = "50%";
      s.style.top = "50%";
      s.style.setProperty("--x", `${Math.cos(angle) * distance}px`);
      s.style.setProperty("--y", `${Math.sin(angle) * distance}px`);
      s.style.color = i % 3 === 0 ? "#ffe580" : i % 3 === 1 ? "#67e7ff" : "#d98cff";
      sparkles.appendChild(s);
    }

    wrap.classList.add("show");
    setTimeout(() => wrap.classList.remove("show"), 2300);
  }

  async function loadState() {
    if (!supabase) return;
    connectionStatus.textContent = "Loading live standings…";
    const { data, error } = await supabase
      .from("leaderboard_state")
      .select("state")
      .eq("id", 1)
      .single();

    if (error) {
      console.error(error);
      connectionStatus.textContent = `Could not load standings: ${error.message}`;
      return;
    }

    maybeCelebrate(data.state);
    renderLeaderboard();
    connectionStatus.textContent = "Live";
  }

  function subscribeRealtime() {
    console.log("Connecting Realtime to:", cfg.supabaseUrl);
  
    if (realtimeChannel) {
      supabase.removeChannel(realtimeChannel);
    }
  
    realtimeChannel = supabase
      .channel("jyotara-live-" + Math.random().toString(36).slice(2))
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "leaderboard_state"
        },
        payload => {
          console.log("REALTIME EVENT RECEIVED:", payload);
  
          if (!payload.new || !payload.new.state) {
            console.warn("Realtime payload did not contain state:", payload);
            return;
          }
  
          maybeCelebrate(payload.new.state);
          renderLeaderboard();
          updateTimerDisplay();
  
          connectionStatus.textContent = "Live";
        }
      )
      .subscribe((status, error) => {
        console.log("Realtime status:", status);
        console.log("Realtime error:", error);
  
        if (status === "SUBSCRIBED") {
          connectionStatus.textContent = "Live";
        } else if (status === "CHANNEL_ERROR") {
          connectionStatus.textContent =
            "Live connection interrupted — syncing automatically";
        } else if (status === "TIMED_OUT") {
          connectionStatus.textContent =
            "Live connection timed out — syncing automatically";
        }
      });
  }

  async function refreshAuth() {
    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    isAdmin = Boolean(data.session);
    loginSection.classList.toggle("hidden", isAdmin);
    adminSection.classList.toggle("hidden", !isAdmin);
    renderLeaderboard();
  }

  function updateTimerDisplay() {
    if (!state.timerVisible) return;
    const end = state.timerEndsAt ? new Date(state.timerEndsAt).getTime() : Date.now();
    const remainingMs = Math.max(0, end - Date.now());
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    timerDisplay.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  document.getElementById("adminOpenBtn").addEventListener("click", () => adminDialog.showModal());
  document.getElementById("adminCloseBtn").addEventListener("click", () => adminDialog.close());

  document.getElementById("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (!supabase) return;
    loginMessage.textContent = "Signing in…";

    const email = document.getElementById("emailInput").value.trim();
    const password = document.getElementById("passwordInput").value;

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      loginMessage.textContent = error.message;
      return;
    }

    loginMessage.textContent = "";
    await refreshAuth();
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    await refreshAuth();
  });

  document.getElementById("hideAllBtn").addEventListener("click", async () => {
    const next = structuredClone(state);
    next.standingsHidden = true;
    next.revealedPlacements = [];
    await saveState(next);
  });

  document.getElementById("revealAllBtn").addEventListener("click", async () => {
    const next = structuredClone(state);
    next.standingsHidden = false;
    next.revealedPlacements = [];
    await saveState(next);
  });

  document.getElementById("showTimerBtn").addEventListener("click", async () => {
    const minutes = Math.max(0, Number(document.getElementById("timerMinutes").value) || 0);
    const seconds = Math.min(59, Math.max(0, Number(document.getElementById("timerSeconds").value) || 0));
    const totalSeconds = Math.floor(minutes * 60 + seconds);

    const next = structuredClone(state);
    next.timerVisible = true;
    next.timerEndsAt = new Date(Date.now() + totalSeconds * 1000).toISOString();
    await saveState(next);
    updateTimerDisplay();
  });

  document.getElementById("hideTimerBtn").addEventListener("click", async () => {
    const next = structuredClone(state);
    next.timerVisible = false;
    next.timerEndsAt = null;
    await saveState(next);
  });

  async function syncStateFromDatabase() {
    if (!supabase) return;
  
    const { data, error } = await supabase
      .from("leaderboard_state")
      .select("state")
      .eq("id", 1)
      .single();
  
    if (error || !data?.state) {
      console.error("Backup sync error:", error);
      return;
    }
  
    const incomingState = normalizeState(data.state);
  
    // Only render if something actually changed.
    if (JSON.stringify(incomingState) !== JSON.stringify(state)) {
      console.log("Database sync update received:", incomingState);
  
      maybeCelebrate(incomingState);
      renderLeaderboard();
      updateTimerDisplay();
    }
  }
  
  async function init() {
    renderLeaderboard();
    setInterval(updateTimerDisplay, 250);

    if (!configReady) {
      connectionStatus.textContent = "Setup required: add your Supabase URL and anon key in index.html.";
      return;
    }

    supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    supabase.auth.onAuthStateChange(() => refreshAuth());

    await refreshAuth();
    await loadState();
    subscribeRealtime();
    updateTimerDisplay();
    
    // Backup synchronization.
    // Realtime should update instantly, but this makes sure every device
    // always catches up even if a websocket event is missed.
    setInterval(syncStateFromDatabase, 1500);
  }

  init();
})();
