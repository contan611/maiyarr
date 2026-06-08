const $ = (id) => document.getElementById(id);

const roleLabels = {
  mafia: "마피아",
  doctor: "의사",
  detective: "경찰",
  joker: "조커",
  citizen: "시민",
};

const phaseLabels = {
  lobby: "대기실",
  night: "밤",
  day: "낮",
  ended: "종료",
};

let socket;
let state;
let meta = { currentUrl: location.origin, lanUrl: location.origin };
let activeTab = "chat";
let settingsDirty = false;
let reconnectDelay = 500;
let autoJoinRoom = null;
let reconnectTimer = null;
let connectionToastAt = 0;
let lastEventId = null;
let account = null;
let selectedMode = "mafia";
let lastFootballEventId = null;
let lastMiniEventId = null;
let lastAdminStatsRequestAt = 0;
let miniSpinStartedAt = 0;
let miniRevealTimer = null;
const sessionId = getSessionId();

async function loadMeta() {
  try {
    const response = await fetch("/meta", { cache: "no-store" });
    meta = await response.json();
  } catch {
    meta = { currentUrl: location.origin, lanUrl: location.origin };
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}?sid=${sessionId}`);
  socket.addEventListener("open", () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectDelay = 500;
    const token = localStorage.getItem("mafiaAuthToken") || sessionStorage.getItem("mafiaAuthToken");
    if (token) send("authRestore", { token });
    else showAuth();
  });
  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "state") {
      autoJoinRoom = null;
      state = data.state;
      if (state.account) setAccount(state.account);
      localStorage.setItem("mafiaRoomCode", state.code);
      render();
    } else if (data.type === "auth") {
      if (data.user) {
        setAccount(data.user);
        if (data.token) {
          sessionStorage.removeItem("mafiaAuthToken");
          localStorage.setItem("mafiaAuthToken", data.token);
          localStorage.setItem("mafiaRememberLogin", "1");
        } else if (data.sessionToken) {
          localStorage.removeItem("mafiaAuthToken");
          localStorage.setItem("mafiaRememberLogin", "0");
          sessionStorage.setItem("mafiaAuthToken", data.sessionToken);
        }
        showHome();
      } else {
        account = null;
        localStorage.removeItem("mafiaAuthToken");
        localStorage.removeItem("mafiaRememberLogin");
        sessionStorage.removeItem("mafiaAuthToken");
        showAuth();
      }
    } else if (data.type === "usernameCheck") {
      $("idCheckText").textContent = data.message;
      $("idCheckText").classList.toggle("ok", Boolean(data.ok));
      $("idCheckText").classList.toggle("bad", !data.ok);
    } else if (data.type === "left") {
      leaveLocalRoom();
    } else if (data.type === "adminFeedback") {
      renderAdminFeedback(data.feedbacks || []);
      if (data.latest) toast(`새 피드백: ${data.latest.displayName || data.latest.username}`);
    } else if (data.type === "adminStats") {
      renderAdminStats(data);
    } else if (data.type === "toast") {
      toast(data.message);
    } else if (data.type === "error" || data.type === "notice") {
      if (autoJoinRoom && data.message.includes("방 코드")) {
        localStorage.removeItem("mafiaRoomCode");
        autoJoinRoom = null;
        state = null;
        $("joinPanel").classList.remove("hidden");
        $("gamePanel").classList.add("hidden");
        return;
      }
      toast(data.message);
    }
  });
  socket.addEventListener("close", () => {
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const now = Date.now();
  if (!state && now - connectionToastAt > 8000) {
    toast("서버에 연결하는 중입니다.");
    connectionToastAt = now;
  }
  reconnectTimer = setTimeout(() => {
    socket = null;
    reconnectTimer = null;
    connect();
    reconnectDelay = Math.min(5000, reconnectDelay * 1.7);
  }, reconnectDelay);
}

function send(action, extra = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast("서버에 연결 중입니다. 잠시 뒤 다시 시도하세요.");
    return;
  }
  socket.send(JSON.stringify({ action, ...extra }));
}

function nameValue() {
  return account?.displayName || account?.username || $("nameInput").value.trim() || `학생${Math.floor(Math.random() * 90 + 10)}`;
}

function setAccount(user) {
  account = user;
  $("nameInput").value = user?.displayName || user?.username || "";
  $("profileDisplayName").value = user?.displayName || user?.username || "";
  $("homeTitle").textContent = user ? `${user.displayName || user.username} 님, 게임 선택` : "게임 선택";
  $("adminBadge").classList.toggle("hidden", !user?.isAdmin);
  $("adminFeedbackBox")?.classList.toggle("hidden", !user?.isAdmin);
  $("deleteAccountBtn")?.classList.toggle("hidden", Boolean(user?.isAdmin));
  if (user?.isAdmin) send("feedbackList");
}

function showAuth() {
  $("authPanel").classList.remove("hidden");
  $("homePanel").classList.add("hidden");
  $("joinPanel").classList.add("hidden");
  $("gamePanel").classList.add("hidden");
  $("rememberLogin").checked = localStorage.getItem("mafiaRememberLogin") !== "0";
}

function showHome() {
  if (!account) return showAuth();
  state = null;
  $("authPanel").classList.add("hidden");
  $("homePanel").classList.remove("hidden");
  $("joinPanel").classList.add("hidden");
  $("gamePanel").classList.add("hidden");
}

function showJoin(mode) {
  selectedMode = ["mafia", "football", "mini"].includes(mode) ? mode : "mafia";
  $("authPanel").classList.add("hidden");
  $("homePanel").classList.add("hidden");
  $("joinPanel").classList.remove("hidden");
  $("gamePanel").classList.add("hidden");
  const labels = {
    mafia: ["Mafia", "마피아", "마피아 방을 만들거나 방 코드로 입장하세요.", "마피아 방 만들기"],
    football: ["Football Bet", "AI 축구 베팅", "AI 축구 베팅 방을 만들거나 방 코드로 입장하세요.", "축구 베팅 방 만들기"],
    mini: ["Mini Games", "미니게임", "미니게임 방을 만들거나 방 코드로 입장하세요.", "미니게임 방 만들기"],
  };
  const label = labels[selectedMode];
  $("selectedModeEyebrow").textContent = label[0];
  $("selectedModeTitle").textContent = label[1];
  $("selectedModeText").textContent = label[2];
  $("createBtn").textContent = label[3];
}

function authSubmit(action) {
  send(action, {
    username: $("loginIdInput").value,
    password: $("loginPwInput").value,
    displayName: $("displayNameInput").value,
    remember: $("rememberLogin").checked,
  });
}

function saveProfile() {
  send("profileUpdate", {
    displayName: $("profileDisplayName").value,
    currentPassword: $("currentPasswordInput").value,
    newPassword: $("newPasswordInput").value,
  });
  $("currentPasswordInput").value = "";
  $("newPasswordInput").value = "";
}

function deleteAccount() {
  if (!account || account.isAdmin) return toast("운영자 계정은 삭제할 수 없습니다.");
  const password = $("currentPasswordInput").value;
  if (!password) return toast("탈퇴하려면 현재 비밀번호를 입력하세요.");
  if (!confirm("정말 계정을 탈퇴할까요? 이 계정 데이터는 삭제됩니다.")) return;
  send("accountDelete", { password });
}

function render() {
  if (!state) return;
  $("joinPanel").classList.add("hidden");
  $("gamePanel").classList.remove("hidden");

  const isHost = state.you?.id === state.hostId;
  const canManage = isHost || state.account?.isAdmin;
  const isFootball = state.mode === "football";
  const isMini = state.mode === "mini";
  const role = state.you?.role;
  $("adminToolsPanel")?.classList.toggle("hidden", !state.account?.isAdmin);
  if (state.account?.isAdmin && Date.now() - lastAdminStatsRequestAt > 4000) {
    lastAdminStatsRequestAt = Date.now();
    send("adminStats");
  }
  $("roomCode").textContent = state.code;
  $("phaseText").textContent = isFootball ? footballPhaseLabel(state.football?.phase) : isMini ? "미니게임" : phaseLabels[state.phase] || state.phase;
  $("winnerText").textContent = state.winnerText || "";
  $("winnerText").classList.toggle("hidden", !state.winnerText);
  $("roleText").textContent = role ? roleLabels[role] : "미정";
  $("roleDescription").textContent = role ? state.roleInfo[role]?.description || "" : "게임이 시작되면 역할이 배정됩니다.";
  $("aliveText").textContent = state.phase === "lobby" ? "대기 중" : state.you?.alive ? "생존" : "탈락";
  $("playerCount").textContent = `${state.players.length}명`;
  $("progressLabel").textContent = state.progress?.label || "대기";
  $("progressCount").textContent = `${state.progress?.done || 0}/${state.progress?.needed || 0}`;

  $("settingsPanel").classList.toggle("hidden", state.phase !== "lobby");
  $("startBtn").classList.toggle("hidden", !(canManage && state.phase === "lobby"));
  $("startBtn").textContent = state.mode === "football" ? "베팅 열기" : "게임 시작";
  $("resetBtn").classList.toggle("hidden", !canManage);
  $("identityPanel").classList.toggle("hidden", isFootball || isMini);
  $("actionPanel").classList.toggle("hidden", isFootball || isMini);
  $("footballPanel").classList.toggle("hidden", !isFootball);
  $("miniPanel").classList.toggle("hidden", !isMini);
  $("mafiaSettingsGrid").classList.toggle("hidden", isFootball || isMini);
  $("footballStartBtn").classList.toggle("hidden", !(canManage && isFootball));
  document.querySelectorAll(".mode-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
    button.disabled = !canManage || state.phase !== "lobby";
  });
  setSettingsInputs(canManage);

  renderPlayers();
  renderPrivateTargets();
  renderAdminGrantTargets();
  if (!isFootball && !isMini) renderTargets();
  renderFootball();
  renderMini();
  renderFeed();
  renderEvent();
}

function setSettingsInputs(isHost) {
  if (!settingsDirty) {
    for (const key of ["mafiaCount", "detectiveCount", "doctorCount", "jokerCount"]) $(key).value = state.settings[key];
    $("revealOnDeath").checked = state.settings.revealOnDeath;
    $("allowDeadChat").checked = state.settings.allowDeadChat;
    $("autoAdvance").checked = state.settings.autoAdvance;
  }
  document.querySelectorAll("#settingsPanel input").forEach((input) => {
    input.disabled = !isHost;
  });
}

function currentSettings() {
  return {
    mafiaCount: $("mafiaCount").value,
    detectiveCount: $("detectiveCount").value,
    doctorCount: $("doctorCount").value,
    jokerCount: $("jokerCount").value,
    revealOnDeath: $("revealOnDeath").checked,
    allowDeadChat: $("allowDeadChat").checked,
    autoAdvance: $("autoAdvance").checked,
  };
}

function pushSettings() {
  settingsDirty = false;
  send("settings", { settings: currentSettings() });
}

function renderPlayers() {
  $("playersList").innerHTML = state.players
    .map((player) => {
      const badges = [];
      if (player.isHost) badges.push(`<span class="badge host">방장</span>`);
      if (player.isYou) badges.push(`<span class="badge">나</span>`);
      if (!player.connected) badges.push(`<span class="badge dead">오프라인</span>`);
      if (player.spectator) badges.push(`<span class="badge">관전</span>`);
      if (!player.alive) badges.push(`<span class="badge dead">탈락</span>`);
      if (player.role) badges.push(`<span class="badge ${player.role}">${roleLabels[player.role]}</span>`);
      return `
        <div class="player-row ${player.alive ? "" : "is-dead"}">
          <div>
            <strong>${escapeHtml(player.name)}</strong>
            <div class="badges">${badges.join("")}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderPrivateTargets() {
  const select = $("privateTargetSelect");
  if (!select || !state?.players) return;
  const current = select.value;
  const options = [`<option value="">전체</option>`].concat(
    state.players
      .filter((player) => player.id !== state.you?.id)
      .map((player) => `<option value="${player.id}">${escapeHtml(player.name)}</option>`),
  );
  select.innerHTML = options.join("");
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderAdminGrantTargets() {
  const select = $("adminGrantTarget");
  if (!select || !state?.players) return;
  const current = select.value;
  select.innerHTML = state.players
    .map((player) => `<option value="${player.id}">${escapeHtml(player.name)}${player.isYou ? " (나)" : ""}</option>`)
    .join("");
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderTargets() {
  const you = state.you || {};
  const mode = actionMode(you);
  $("actionHelp").textContent = mode.help;
  $("actionMode").textContent = mode.label;

  const targets = state.players.filter((player) => {
    if (player.spectator) return false;
    if (state.phase === "day") return player.alive;
    if (state.phase === "night") return player.alive;
    return false;
  });

  if (!targets.length && !mode.canAct) {
    $("targetList").innerHTML = `<p class="hint">${mode.empty}</p>`;
    return;
  }

  const skipRow = mode.canAct ? `
    <div class="target-row ${state.selectedSkip ? "selected" : ""}">
      <div>
        <strong>건너뛰기</strong>
        <span>이번 단계에서 아무도 선택하지 않습니다.</span>
      </div>
      <button data-target="skip">${state.selectedSkip ? "선택됨" : "선택"}</button>
    </div>
  ` : "";

  $("targetList").innerHTML = skipRow + targets
    .map((player) => {
      const selected = player.votedByYou || player.actedByYou;
      return `
        <div class="target-row ${selected ? "selected" : ""}">
          <div>
            <strong>${escapeHtml(player.name)}</strong>
            ${player.role ? `<span>${roleLabels[player.role]}</span>` : ""}
          </div>
          <button ${mode.canAct ? "" : "disabled"} data-target="${player.id}">${selected ? "선택됨" : "선택"}</button>
        </div>
      `;
    })
    .join("");
  document.querySelectorAll("[data-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest(".target-row");
      row?.classList.remove("pulse-pick");
      void row?.offsetWidth;
      row?.classList.add("pulse-pick");
      send("vote", { target: button.dataset.target });
    });
  });
}

function actionMode(you) {
  if (state.phase === "lobby") return { label: "대기", canAct: false, help: "방 설정을 확인하고 참가자를 기다리세요.", empty: "게임 시작 전입니다." };
  if (state.phase === "ended") return { label: "종료", canAct: false, help: "게임이 끝났습니다. 방장이 초기화할 수 있습니다.", empty: "선택할 대상이 없습니다." };
  if (you.spectator) return { label: "관전", canAct: false, help: "진행 중 입장한 사람은 관전자로 참여합니다.", empty: "관전 중입니다." };
  if (!you.alive) return { label: "관전", canAct: false, help: "탈락자는 행동할 수 없습니다. 탈락자 채팅은 탈락자 탭에서 가능합니다.", empty: "관전 중입니다." };
  if (state.phase === "day") return { label: "투표", canAct: true, help: "토론 후 처형할 사람에게 투표하세요.", empty: "투표할 생존자가 없습니다." };
  if (you.role === "mafia") return { label: "암살", canAct: true, help: "밤에 암살할 대상을 선택하세요.", empty: "대상이 없습니다." };
  if (you.role === "doctor") return { label: "보호", canAct: true, help: "마피아가 노릴 것 같은 사람을 보호하세요.", empty: "대상이 없습니다." };
  if (you.role === "detective") return { label: "조사", canAct: true, help: "마피아로 의심되는 사람을 조사하세요.", empty: "대상이 없습니다." };
  return { label: "휴식", canAct: false, help: "밤에는 특수 역할만 행동합니다.", empty: "밤 행동이 없습니다." };
}

function renderFeed() {
  if (activeTab === "dead" && !state.canUseDeadChat) activeTab = "chat";
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === activeTab);
    if (tab.dataset.tab === "dead") tab.disabled = !state.canUseDeadChat;
  });
  $("chatView").classList.toggle("hidden", activeTab !== "chat");
  $("deadView").classList.toggle("hidden", activeTab !== "dead");
  $("logView").classList.toggle("hidden", activeTab !== "log");
  $("noticeView").classList.toggle("hidden", activeTab !== "notice");
  $("chatInput").placeholder = activeTab === "dead" ? "탈락자끼리만 보이는 메시지" : "메시지";

  $("chatView").innerHTML = renderMessages(state.messages, "아직 채팅이 없습니다.");
  $("deadView").innerHTML = state.canUseDeadChat
    ? renderMessages(state.deadMessages, "아직 탈락자 채팅이 없습니다.")
    : `<p class="hint">탈락한 플레이어끼리만 사용할 수 있습니다.</p>`;
  $("logView").innerHTML = state.log.length
    ? state.log.map((line) => `<div class="log-line ${line.level || ""}"><p>${escapeHtml(line.text)}</p><span class="time">${timeText(line.at)}</span></div>`).join("")
    : `<p class="hint">아직 기록이 없습니다.</p>`;
  $("noticeView").innerHTML = state.notices.length
    ? state.notices.map((line) => `<div class="log-line notice"><p>${escapeHtml(line.text)}</p><span class="time">${timeText(line.at)}</span></div>`).join("")
    : `<p class="hint">경찰 조사 결과 같은 개인 정보가 여기에 표시됩니다.</p>`;
  for (const id of ["chatView", "deadView", "logView", "noticeView"]) $(id).scrollTop = $(id).scrollHeight;
}

function renderMessages(messages, emptyText) {
  return messages.length
    ? messages.map((message) => `
      <div class="message">
        <strong>${escapeHtml(message.from)} <span class="time">${timeText(message.at)}</span></strong>
        <p>${escapeHtml(message.text)}</p>
      </div>`).join("")
    : `<p class="hint">${emptyText}</p>`;
}

function renderFootball() {
  if (state.mode !== "football" || !state.football) return;
  const football = state.football;
  $("homeTeam").textContent = football.teams?.[0] || "홈팀";
  $("awayTeam").textContent = football.teams?.[1] || "원정팀";
  $("homeScore").textContent = football.score?.[0] ?? 0;
  $("awayScore").textContent = football.score?.[1] ?? 0;
  $("footballPhase").textContent = footballPhaseLabel(football.phase);
  $("footballClock").textContent = footballClockText(football);
  $("footballResult").textContent = football.winnerText || footballSummary(football);
  renderPitch(football);
  $("footballWallet").textContent = football.isAdminWallet ? "∞" : `${football.wallet ?? 0}`;
  $("betAmount").max = football.isAdminWallet ? 1000000 : Math.max(10, football.wallet ?? 0);
  document.querySelector(".bet-strip")?.classList.remove("hidden");

  if (football.myBet) {
    const team = football.myBet.side === "home" ? football.teams[0] : football.teams[1];
    $("myFootballBet").textContent = `${team} ${football.myBet.amount}P`;
  } else {
    $("myFootballBet").textContent = "없음";
  }

  document.querySelectorAll(".bet-btn").forEach((button) => {
    button.disabled = state.mode !== "football" || football.phase !== "betting";
    button.classList.toggle("selected", football.myBet?.side === button.dataset.side);
  });

  $("footballEvents").innerHTML = football.events?.length
    ? football.events.slice().reverse().map((line) => `<div class="football-line ${line.level || ""}">${escapeHtml(line.text)}<span>${timeText(line.at)}</span></div>`).join("")
    : `<p class="hint">아직 경기 기록이 없습니다.</p>`;
  $("footballLeaders").innerHTML = football.leaders?.length
    ? football.leaders.map((player, index) => `<div class="football-line"><b>${index + 1}. ${escapeHtml(player.name)}</b><strong>${player.coins}P</strong></div>`).join("")
    : `<p class="hint">아직 참가자가 없습니다.</p>`;
}

function renderMini() {
  if (state.mode !== "mini" || !state.mini) return;
  $("miniWallet").textContent = state.mini.isAdminWallet ? "∞" : `${state.mini.wallet ?? 0}`;
  const maxBet = state.mini.isAdminWallet ? 1000000 : Math.max(0, (Number(state.mini.wallet) || 0) - 100);
  $("miniAmount").max = Math.max(10, maxBet);
  document.querySelectorAll(".mini-btn").forEach((button) => {
    button.disabled = !state.mini.isAdminWallet && maxBet < 10;
  });
  const latest = state.mini.events?.at(-1);
  renderMiniEffect(latest);
  $("miniEvents").innerHTML = state.mini.events?.length
    ? state.mini.events.slice().reverse().map((line) => `<div class="football-line ${line.level || ""}">${escapeHtml(line.text)}<span>${timeText(line.at)}</span></div>`).join("")
    : `<p class="hint">아직 미니게임 기록이 없습니다.</p>`;
}

function startMiniEffect(game, choice) {
  const stage = $("miniStage");
  if (!stage) return;
  miniSpinStartedAt = Date.now();
  clearTimeout(miniRevealTimer);
  stage.className = `mini-stage rolling ${game}`;
  stage.dataset.result = "";
  $("coinVisual").textContent = "?";
  $("diceVisual").textContent = "?";
  $("diceVisual").dataset.roll = "";
  $("numberVisual").textContent = "?";
  $("numberVisual").dataset.roll = "";
  $("rouletteVisual").dataset.result = "";
  $("rouletteVisual").style.setProperty("--roulette-stop", "900deg");
  $("rouletteVisual").querySelector("span").textContent = "";
  $("miniResultTitle").textContent = game === "roulette" ? "룰렛 회전 중" : game === "dice" ? "주사위 굴리는 중" : game === "coin" ? "동전 뒤집는 중" : "숫자 추첨 중";
  $("miniResultText").textContent = `선택: ${choice}`;
}

function renderMiniEffect(event) {
  if (!event || !event.game) return;
  const eventId = `${event.at}:${event.text}`;
  if (eventId === lastMiniEventId) return;
  const stage = $("miniStage");
  if (!stage) return;
  const reveal = () => {
    if (eventId === lastMiniEventId) return;
    lastMiniEventId = eventId;
  stage.className = `mini-stage settled ${event.game} ${event.win ? "win" : "lose"}`;
  stage.dataset.result = event.result || "";
  $("miniResultTitle").textContent = event.win ? "성공!" : "실패";
  $("miniResultText").textContent = `성공률 ${event.chance}% · 성공 시 ${event.amount * event.multiplier}P · 결과 ${event.resultLabel} · ${event.win ? `${event.payout}P 획득` : "베팅 실패"}`;
  $("coinVisual").textContent = event.game === "coin" ? (event.result === "back" ? "뒤" : "앞") : "?";
  $("diceVisual").textContent = event.game === "dice" ? event.resultLabel : "?";
  $("diceVisual").dataset.roll = event.game === "dice" ? event.resultLabel : "";
  $("numberVisual").textContent = event.game === "number" ? event.resultLabel : "?";
  $("numberVisual").dataset.roll = event.game === "number" ? event.resultLabel : "";
  const roulette = $("rouletteVisual");
  roulette.dataset.result = event.result || "";
  const rouletteAngles = { red: "1110deg", black: "1260deg", green: "1410deg" };
  roulette.style.setProperty("--roulette-stop", rouletteAngles[event.result] || "1080deg");
  roulette.querySelector("span").textContent = event.game === "roulette" ? event.resultLabel : "";
  };
  const wait = Math.max(0, 1050 - (Date.now() - miniSpinStartedAt));
  if (stage.classList.contains("rolling") && wait > 0) miniRevealTimer = setTimeout(reveal, wait);
  else reveal();
}

function renderPitch(football) {
  const pitch = $("footballPitch");
  const ball = $("footballBall");
  const latest = football.events?.at(-1);
  const latestId = latest ? `${latest.at}:${latest.text}` : `${football.phase}:idle`;
  pitch.classList.toggle("is-running", football.phase === "running");
  pitch.classList.toggle("is-betting", football.phase === "betting");
  pitch.classList.toggle("is-finished", football.phase === "finished");
  pitch.classList.toggle("is-goal", football.lastShot === "goal");
  pitch.classList.toggle("is-save", football.lastShot === "save");

  if (latestId !== lastFootballEventId) {
    lastFootballEventId = latestId;
    const position = ballPositionFor(football, latest);
    ball.style.setProperty("--ball-x", `${position.x}%`);
    ball.style.setProperty("--ball-y", `${position.y}%`);
    updateFootballPlayers(football, position);
    $("playBanner").textContent = pitchBannerText(football, latest);
    pitch.classList.remove("pitch-hit");
    void pitch.offsetWidth;
    pitch.classList.add("pitch-hit");
  }
}

function updateFootballPlayers(football, ball) {
  const pitch = $("footballPitch");
  const homeAttack = football.attackSide !== "away";
  const press = football.lastShot === "goal" ? 7 : football.lastShot === "save" ? 4 : 0;
  const jitter = (seed) => ((football.minute || 1) * (seed + 3)) % 9 - 4;
  const homeBase = homeAttack ? [28, 43, 58] : [18, 31, 43];
  const awayBase = homeAttack ? [57, 69, 82] : [42, 57, 72];
  const coords = [
    [homeBase[0] + jitter(1), 32 + jitter(2)],
    [homeBase[1] + jitter(3), 56 + jitter(4)],
    [Math.min(86, ball.x - 11 + press), Math.max(20, Math.min(80, ball.y + jitter(5)))],
    [awayBase[2] + jitter(6), 68 + jitter(7)],
    [awayBase[1] + jitter(8), 43 + jitter(9)],
    [Math.max(14, ball.x + 11 - press), Math.max(20, Math.min(80, ball.y + jitter(10)))],
  ];
  coords.forEach(([x, y], index) => {
    pitch.style.setProperty(`--p${index + 1}x`, `${Math.max(8, Math.min(92, x))}%`);
    pitch.style.setProperty(`--p${index + 1}y`, `${Math.max(12, Math.min(88, y))}%`);
  });
}

function ballPositionFor(football, latest) {
  if (football.phase === "idle") return { x: 50, y: 50 };
  if (football.phase === "betting") return { x: 50, y: 50 };
  if (football.phase === "finished") return football.winner === "home" ? { x: 88, y: 50 } : { x: 12, y: 50 };
  const text = latest?.text || "";
  const homeAttack = football.attackSide !== "away";
  if (football.lastShot === "goal" || text.includes("득점")) {
    return homeAttack ? { x: 91, y: 50 } : { x: 9, y: 50 };
  }
  if (football.lastShot === "save" || text.includes("슈팅")) {
    return homeAttack ? { x: 82, y: 45 } : { x: 18, y: 55 };
  }
  if (football.lastShot === "post") return homeAttack ? { x: 88, y: 36 } : { x: 12, y: 64 };
  if (text.includes("크로스")) return homeAttack ? { x: 72, y: 26 } : { x: 28, y: 74 };
  return {
    x: homeAttack ? 35 + Math.floor(Math.random() * 38) : 27 + Math.floor(Math.random() * 38),
    y: 22 + Math.floor(Math.random() * 56),
  };
}

function pitchBannerText(football, latest) {
  if (football.phase === "betting") return "베팅 중";
  if (football.phase === "running") return `${football.minute || 1}' ${latest?.text || "AI 경기 진행 중"}`;
  if (football.phase === "finished") return football.winnerText || "경기 종료";
  return "대기 중";
}

function footballPhaseLabel(phase) {
  return {
    idle: "축구 대기",
    betting: "베팅 중",
    running: "경기 중",
    finished: "경기 종료",
  }[phase] || "축구";
}

function footballClockText(football) {
  if (football.phase !== "betting") return football.phase === "running" ? "LIVE" : "--";
  const left = Math.max(0, Math.ceil((football.betsOpenUntil - Date.now()) / 1000));
  return `${left}초`;
}

function footballSummary(football) {
  if (football.phase === "betting") return `총 베팅 ${football.betCount || 0}명 · 홈 ${football.totals?.home || 0}P / 원정 ${football.totals?.away || 0}P`;
  if (football.phase === "running") return "AI 경기가 진행 중입니다.";
  if (football.phase === "finished") return "방장이 다시 베팅을 열 수 있습니다.";
  return "방장이 베팅을 열면 시작됩니다.";
}

function renderEvent() {
  const event = state.event;
  if (!event || event.id === lastEventId) return;
  lastEventId = event.id;

  const overlay = $("eventOverlay");
  $("eventKicker").textContent = eventKicker(event);
  $("eventTitle").textContent = event.title || "사건";
  $("eventText").textContent = event.text || "";

  overlay.className = `event-overlay ${event.tone || "info"}`;
  document.body.classList.remove("event-flash", "flash-danger", "flash-night", "flash-success", "flash-vote", "flash-info");
  void overlay.offsetWidth;
  overlay.classList.add("show");
  document.body.classList.add("event-flash", `flash-${event.tone || "info"}`);

  clearTimeout(renderEvent.timer);
  renderEvent.timer = setTimeout(() => {
    overlay.classList.remove("show");
    overlay.classList.add("hidden");
    document.body.classList.remove("event-flash", "flash-danger", "flash-night", "flash-success", "flash-vote", "flash-info");
  }, 2800);
}

function eventKicker(event) {
  if (event.kind?.includes("football")) return "FOOTBALL";
  if (event.kind?.includes("vote")) return "VOTE";
  if (event.kind?.includes("murder") || event.tone === "night") return "NIGHT";
  if (event.kind === "execution") return "DAY";
  if (event.kind === "joker") return "JOKER";
  if (event.kind === "saved") return "SAVE";
  return "EVENT";
}

function inviteUrl() {
  const base = location.hostname === "127.0.0.1" || location.hostname === "localhost" ? (meta.lanUrl || meta.currentUrl || location.origin) : location.origin;
  return `${base}/?room=${encodeURIComponent(state?.code || $("codeInput").value.trim().toUpperCase())}`;
}

async function copyInvite() {
  const url = inviteUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast("초대 링크를 복사했습니다.");
  } catch {
    toast(url);
  }
}

async function shareInvite() {
  const url = inviteUrl();
  if (navigator.share) {
    await navigator.share({ title: "마피아", text: `방 코드 ${state.code}`, url });
  } else {
    await copyInvite();
  }
}

function leaveLocalRoom() {
  localStorage.removeItem("mafiaRoomCode");
  autoJoinRoom = null;
  state = null;
  activeTab = "chat";
  $("gamePanel").classList.add("hidden");
  showHome();
  $("codeInput").value = "";
  toast("방에서 나갔습니다.");
}

function timeText(at) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderAdminFeedback(items) {
  const box = $("adminFeedbackBox");
  if (!box) return;
  box.innerHTML = items.length
    ? items.slice().reverse().map((item) => `<div class="feedback-item"><strong>${escapeHtml(item.displayName || item.username)}</strong><span>${timeText(item.at)}</span><p>${escapeHtml(item.text)}</p></div>`).join("")
    : `<p class="hint">아직 피드백이 없습니다.</p>`;
}

function renderAdminStats(data) {
  const box = $("adminUsersBox");
  if (!box) return;
  $("adminStatsText").textContent = `접속 ${data.clients || 0}명 · 방 ${data.rooms || 0}개 · 계정 ${data.users?.length || 0}개`;
  box.innerHTML = data.users?.length
    ? data.users.map((user) => `
      <div class="admin-user-row">
        <strong>${escapeHtml(user.displayName || user.username)}</strong>
        <span>@${escapeHtml(user.username)} · ${user.isAdmin ? "관리자" : `${user.footballCoins ?? 0}P`}</span>
      </div>`).join("")
    : `<p class="hint">계정 정보가 없습니다.</p>`;
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 3200);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getSessionId() {
  const existing = localStorage.getItem("mafiaSessionId");
  if (existing) return existing;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  localStorage.setItem("mafiaSessionId", id);
  return id;
}

function initFromUrl() {
  const params = new URLSearchParams(location.search);
  const room = params.get("room");
  if (room) $("codeInput").value = room.toUpperCase().slice(0, 4);
  const savedName = localStorage.getItem("mafiaName");
  if (savedName) $("nameInput").value = savedName;
}

$("loginBtn").addEventListener("click", () => authSubmit("authLogin"));
$("registerBtn").addEventListener("click", () => authSubmit("authRegister"));
$("checkIdBtn").addEventListener("click", () => send("usernameCheck", { username: $("loginIdInput").value }));
$("loginIdInput").addEventListener("input", () => {
  $("idCheckText").textContent = "아이디와 게임 표시 이름은 따로 사용할 수 있습니다.";
  $("idCheckText").classList.remove("ok", "bad");
});
$("saveProfileBtn").addEventListener("click", saveProfile);
$("deleteAccountBtn").addEventListener("click", deleteAccount);
$("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem("mafiaAuthToken");
  localStorage.removeItem("mafiaRememberLogin");
  sessionStorage.removeItem("mafiaAuthToken");
  send("authLogout");
});
$("backHomeBtn").addEventListener("click", showHome);
document.querySelectorAll("[data-pick-mode]").forEach((button) => {
  button.addEventListener("click", () => showJoin(button.dataset.pickMode));
});
$("createBtn").addEventListener("click", () => send("create", { mode: selectedMode }));
$("joinBtn").addEventListener("click", () => {
  autoJoinRoom = null;
  send("join", { code: $("codeInput").value });
});
$("startBtn").addEventListener("click", () => send("start"));
$("footballStartBtn").addEventListener("click", () => send("start"));
$("resetBtn").addEventListener("click", () => send("reset"));
$("leaveBtn").addEventListener("click", () => send("leave"));
$("adminStartFootballBtn").addEventListener("click", () => send("adminStartFootball"));
$("adminGiftCoinsBtn").addEventListener("click", () => send("adminGiftCoins", { amount: 1000 }));
$("adminGrantBtn").addEventListener("click", () => {
  send("adminGrantCoins", {
    targetId: $("adminGrantTarget").value,
    amount: $("adminGrantAmount").value,
  });
});
$("adminResetRoomBtn").addEventListener("click", () => send("adminResetRoom"));
$("adminRefreshBtn").addEventListener("click", () => {
  lastAdminStatsRequestAt = Date.now();
  send("adminStats");
});
$("copyInviteBtn").addEventListener("click", copyInvite);
$("shareInviteBtn").addEventListener("click", shareInvite);
$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const targetId = $("privateTargetSelect").value;
  if (targetId) send("privateChat", { targetId, text: $("chatInput").value });
  else send("chat", { text: $("chatInput").value, channel: activeTab === "dead" ? "dead" : "public" });
  $("chatInput").value = "";
});
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab;
    renderFeed();
  });
});
document.querySelectorAll("#settingsPanel input").forEach((input) => {
  input.addEventListener("input", () => {
    settingsDirty = true;
    clearTimeout(pushSettings.timer);
    pushSettings.timer = setTimeout(pushSettings, 250);
  });
  input.addEventListener("change", pushSettings);
});
document.querySelectorAll(".mode-btn").forEach((button) => {
  button.addEventListener("click", () => send("mode", { mode: button.dataset.mode }));
});
document.querySelectorAll(".bet-btn").forEach((button) => {
  button.addEventListener("click", () => {
    const amount = $("betAmount").value || 100;
    button.classList.remove("pulse-pick");
    void button.offsetWidth;
    button.classList.add("pulse-pick");
    send("footballBet", { side: button.dataset.side, amount });
  });
});
document.querySelectorAll(".mini-btn").forEach((button) => {
  button.addEventListener("click", () => {
    const amount = $("miniAmount").value || 100;
    button.classList.remove("pulse-pick");
    void button.offsetWidth;
    button.classList.add("pulse-pick");
    startMiniEffect(button.dataset.game, button.dataset.choice);
    send("miniPlay", { game: button.dataset.game, choice: button.dataset.choice, amount });
  });
});
$("sendFeedbackBtn").addEventListener("click", () => {
  send("feedbackSubmit", { text: $("feedbackInput").value });
  $("feedbackInput").value = "";
});
window.addEventListener("online", connect);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) connect();
});
setInterval(() => {
  if (state?.mode === "football") {
    $("footballClock").textContent = footballClockText(state.football);
    $("footballResult").textContent = state.football?.winnerText || footballSummary(state.football);
  }
}, 500);

(async () => {
  initFromUrl();
  await loadMeta();
  $("serverHint").textContent = `폰/패드 접속 주소: ${meta.lanUrl || location.origin}`;
  connect();
})();


