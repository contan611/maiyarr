const $ = (id) => document.getElementById(id);

const roleLabels = {
  mafia: "마피아",
  doctor: "의사",
  detective: "경찰",
  medium: "영매사",
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
    const savedRoom = localStorage.getItem("mafiaRoomCode");
    const savedName = localStorage.getItem("mafiaName");
    if (savedRoom && savedName) {
      autoJoinRoom = savedRoom;
      send("join", { name: savedName, code: savedRoom, auto: true });
    }
  });
  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "state") {
      autoJoinRoom = null;
      state = data.state;
      localStorage.setItem("mafiaRoomCode", state.code);
      render();
    } else if (data.type === "left") {
      leaveLocalRoom();
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
  const name = $("nameInput").value.trim() || localStorage.getItem("mafiaName") || `학생${Math.floor(Math.random() * 90 + 10)}`;
  localStorage.setItem("mafiaName", name);
  return name;
}

function render() {
  if (!state) return;
  $("joinPanel").classList.add("hidden");
  $("gamePanel").classList.remove("hidden");

  const isHost = state.you?.id === state.hostId;
  const role = state.you?.role;
  $("roomCode").textContent = state.code;
  $("phaseText").textContent = phaseLabels[state.phase] || state.phase;
  $("winnerText").textContent = state.winnerText || "";
  $("winnerText").classList.toggle("hidden", !state.winnerText);
  $("roleText").textContent = role ? roleLabels[role] : "미정";
  $("roleDescription").textContent = role ? state.roleInfo[role]?.description || "" : "게임이 시작되면 역할이 배정됩니다.";
  $("aliveText").textContent = state.phase === "lobby" ? "대기 중" : state.you?.alive ? "생존" : "탈락";
  $("playerCount").textContent = `${state.players.length}명`;
  $("progressLabel").textContent = state.progress?.label || "대기";
  $("progressCount").textContent = `${state.progress?.done || 0}/${state.progress?.needed || 0}`;

  $("settingsPanel").classList.toggle("hidden", state.phase !== "lobby");
  $("startBtn").classList.toggle("hidden", !(isHost && state.phase === "lobby"));
  $("resetBtn").classList.toggle("hidden", !isHost);
  setSettingsInputs(isHost);

  renderPlayers();
  renderTargets();
  renderFeed();
}

function setSettingsInputs(isHost) {
  if (!settingsDirty) {
    for (const key of ["mafiaCount", "detectiveCount", "doctorCount", "mediumCount", "jokerCount"]) $(key).value = state.settings[key];
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
    mediumCount: $("mediumCount").value,
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

function renderTargets() {
  const you = state.you || {};
  const mode = actionMode(you);
  $("actionHelp").textContent = mode.help;
  $("actionMode").textContent = mode.label;

  const targets = state.players.filter((player) => {
    if (player.spectator) return false;
    if (state.phase === "day") return player.alive;
    if (state.phase === "night" && you.role === "medium") return !player.alive;
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
    button.addEventListener("click", () => send("vote", { target: button.dataset.target }));
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
  if (you.role === "medium") return { label: "영매", canAct: true, help: "죽은 사람 한 명의 역할을 확인하세요.", empty: "아직 확인할 사망자가 없습니다." };
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
  $("joinPanel").classList.remove("hidden");
  $("codeInput").value = "";
  toast("방에서 나갔습니다.");
}

function timeText(at) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

$("createBtn").addEventListener("click", () => send("create", { name: nameValue() }));
$("joinBtn").addEventListener("click", () => {
  autoJoinRoom = null;
  send("join", { name: nameValue(), code: $("codeInput").value });
});
$("startBtn").addEventListener("click", () => send("start"));
$("resetBtn").addEventListener("click", () => send("reset"));
$("leaveBtn").addEventListener("click", () => send("leave"));
$("copyInviteBtn").addEventListener("click", copyInvite);
$("shareInviteBtn").addEventListener("click", shareInvite);
$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  send("chat", { text: $("chatInput").value, channel: activeTab === "dead" ? "dead" : "public" });
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
window.addEventListener("online", connect);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) connect();
});

(async () => {
  initFromUrl();
  await loadMeta();
  $("serverHint").textContent = `폰/패드 접속 주소: ${meta.lanUrl || location.origin}`;
  connect();
})();
