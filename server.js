const http = require("http");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const FEEDBACK_FILE = path.join(DATA_DIR, "feedback.json");
const USER_DATA_VERSION = 2;
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "tksxh1357!";
const DEFAULT_ADMIN_DISPLAY_NAME = process.env.ADMIN_DISPLAY_NAME || "\uc6b4\uc601\uc790";
const MAX_PLAYERS = 24;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const LOBBY_DISCONNECT_GRACE_MS = 25000;

const rooms = new Map();
const clients = new Map();
const users = loadUsers();
const feedbacks = loadFeedbacks();
const sessions = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const ROLE_INFO = {
  mafia: {
    label: "마피아",
    team: "mafia",
    description: "밤마다 한 명을 암살하고 낮에는 시민인 척 토론합니다.",
  },
  citizen: {
    label: "시민",
    team: "citizens",
    description: "토론과 투표로 마피아를 찾아냅니다.",
  },
  detective: {
    label: "경찰",
    team: "citizens",
    description: "밤마다 한 명이 마피아인지 조사합니다.",
  },
  doctor: {
    label: "의사",
    team: "citizens",
    description: "밤마다 한 명을 보호해 마피아의 습격을 막습니다.",
  },
  joker: {
    label: "조커",
    team: "joker",
    description: "낮 투표로 처형되면 혼자 승리합니다.",
  },
};

const DEFAULT_SETTINGS = {
  mafiaCount: 1,
  detectiveCount: 0,
  doctorCount: 0,
  jokerCount: 0,
  revealOnDeath: true,
  allowDeadChat: false,
  autoAdvance: true,
};

const FOOTBALL_TEAMS = [
  ["레드 유나이티드", "블루 시티"],
  ["스톰 FC", "썬더 일레븐"],
  ["화이트 타이거즈", "블랙 스타즈"],
  ["네온 서울", "메트로 원더러스"],
  ["아이언 킥스", "골든 윙스"],
];
const FOOTBALL_START_COINS = 1000;
const FOOTBALL_BET_MS = 12000;
const FOOTBALL_TEAM_POOL = [
  ["레드 유나이티드", "블루 시티"],
  ["스톰 FC", "실버 일레븐"],
  ["타이거즈", "블랙 스완즈"],
  ["다온 서울", "메트로 썬더스"],
  ["아이언 윙스", "골든 라이온즈"],
  ["한강 로버스", "네온 애슬레틱"],
];
ensureAdminUser();

function makeId(bytes = 8) {
  return crypto.randomBytes(bytes).toString("hex");
}

function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== USER_DATA_VERSION) return new Map();
    return new Map(Object.entries(parsed.users || {}));
  } catch {
    return new Map();
  }
}

function saveUsers() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify({ version: USER_DATA_VERSION, users: Object.fromEntries(users) }, null, 2));
}

function loadFeedbacks() {
  try {
    const raw = fs.readFileSync(FEEDBACK_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.feedbacks) ? parsed.feedbacks.slice(-200) : [];
  } catch {
    return [];
  }
}

function saveFeedbacks() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify({ feedbacks: feedbacks.slice(-200) }, null, 2));
}

function ensureAdminUser() {
  let user = [...users.values()].find((item) => item.username.toLowerCase() === DEFAULT_ADMIN_USERNAME);
  if (!user) {
    user = {
      id: makeId(8),
      username: DEFAULT_ADMIN_USERNAME,
      createdAt: Date.now(),
    };
  }
  user.displayName = DEFAULT_ADMIN_DISPLAY_NAME;
  user.passwordHash = passwordHash(DEFAULT_ADMIN_PASSWORD);
  user.footballCoins = Number.isFinite(user.footballCoins) ? user.footballCoins : FOOTBALL_START_COINS;
  user.isAdmin = true;
  users.set(user.id, user);
  saveUsers();
}

function normalizeUsername(username) {
  return String(username || "")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .trim()
    .slice(0, 16);
}

function normalizeDisplayName(name, fallback = "") {
  return String(name || fallback || "")
    .replace(/[^\p{L}\p{N} _.-]/gu, "")
    .trim()
    .slice(0, 16);
}

function passwordHash(password, salt = makeId(12)) {
  const hash = crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt] = String(stored || "").split(":");
  return passwordHash(password, salt) === stored;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    footballCoins: user.footballCoins ?? FOOTBALL_START_COINS,
    isAdmin: isAdminUser(user),
  };
}

function isAdminUser(user) {
  if (!user) return false;
  const configured = String(process.env.ADMIN_USERS || "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return Boolean(user.isAdmin || configured.includes(String(user.username).toLowerCase()));
}

function footballCoinsFor(accountId) {
  if (!accountId) return FOOTBALL_START_COINS;
  const user = users.get(accountId);
  return user?.footballCoins ?? FOOTBALL_START_COINS;
}

function saveFootballCoins(accountId, coins) {
  if (!accountId) return;
  const user = users.get(accountId);
  if (!user) return;
  user.footballCoins = Math.max(0, Math.floor(coins));
  users.set(accountId, user);
  saveUsers();
}

function authName(client) {
  const user = users.get(client?.userId);
  return user ? user.displayName || user.username : null;
}

function createSession(userId) {
  const token = makeId(24);
  sessions.set(token, userId);
  return token;
}

function isAdminClient(client) {
  return isAdminUser(users.get(client?.userId));
}


function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return rooms.has(code) ? makeRoomCode() : code;
}

function sanitizeName(name) {
  return String(name || "")
    .replace(/[^\p{L}\p{N} _.-]/gu, "")
    .trim()
    .slice(0, 16) || "학생";
}

function normalizeMode(mode) {
  return ["mafia", "football", "mini"].includes(mode) ? mode : "mafia";
}

function cleanText(text, max = 240) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function publicAddress() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) return `http://${net.address}:${PORT}`;
    }
  }
  return `http://127.0.0.1:${PORT}`;
}

function serverMeta(req) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const protocol = req.headers["x-forwarded-proto"] || "http";
  return {
    localUrl: `http://127.0.0.1:${PORT}`,
    lanUrl: publicAddress(),
    currentUrl: `${protocol}://${host}`,
    port: PORT,
  };
}

function createRoom(hostId, hostName, mode = "mafia", accountId = null) {
  const code = makeRoomCode();
  const roomMode = normalizeMode(mode);
  const room = {
    code,
    hostId,
    mode: roomMode,
    phase: "lobby",
    day: 0,
    winner: null,
    winnerText: "",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    settings: { ...DEFAULT_SETTINGS },
    players: new Map(),
    dayVotes: new Map(),
    nightActions: {
      mafia: new Map(),
      doctor: new Map(),
      detective: new Map(),
    },
    disconnectTimers: new Map(),
    privateNotices: new Map(),
    messages: [],
    deadMessages: [],
    log: [],
    events: [],
    football: createFootballState(),
    footballWallets: new Map(),
    footballBets: new Map(),
    footballDirectActions: new Map(),
    footballTimers: [],
    miniEvents: [],
  };
  rooms.set(code, room);
  addPlayer(room, hostId, hostName, accountId);
  addLog(room, `${room.players.get(hostId).name} 님이 방을 만들었습니다.`);
  return room;
}

function addPlayer(room, id, name, accountId = null) {
  if (room.disconnectTimers.has(id)) {
    clearTimeout(room.disconnectTimers.get(id));
    room.disconnectTimers.delete(id);
  }
  if (room.players.has(id)) {
    const existing = room.players.get(id);
    existing.connected = true;
    if (name) existing.name = sanitizeName(name);
    if (accountId) existing.accountId = accountId;
    if (!room.footballWallets.has(id)) room.footballWallets.set(id, footballCoinsFor(accountId));
    touch(room);
    return existing;
  }
  const player = {
    id,
    name: sanitizeName(name),
    alive: room.phase === "lobby",
    role: null,
    joinedAt: Date.now(),
    connected: true,
    spectator: room.phase !== "lobby",
    accountId,
  };
  room.players.set(id, player);
  if (!room.footballWallets.has(id)) room.footballWallets.set(id, footballCoinsFor(accountId));
  touch(room);
  return player;
}

function touch(room) {
  room.lastActiveAt = Date.now();
}

function roleLabel(role) {
  return ROLE_INFO[role]?.label || "미정";
}

function roleCounts(settings) {
  return {
    mafia: clampInt(settings.mafiaCount, 1, 8),
    detective: clampInt(settings.detectiveCount, 0, 4),
    doctor: clampInt(settings.doctorCount, 0, 4),
    joker: clampInt(settings.jokerCount, 0, 2),
  };
}

function specialRoleTotal(settings) {
  const counts = roleCounts(settings);
  return counts.mafia + counts.detective + counts.doctor + counts.joker;
}

function sanitizeSettings(input, playerCount) {
  const next = { ...DEFAULT_SETTINGS };
  const raw = input || {};
  next.mafiaCount = clampInt(raw.mafiaCount, 1, 8);
  next.detectiveCount = clampInt(raw.detectiveCount, 0, 4);
  next.doctorCount = clampInt(raw.doctorCount, 0, 4);
  next.jokerCount = clampInt(raw.jokerCount, 0, 2);
  next.revealOnDeath = Boolean(raw.revealOnDeath);
  next.allowDeadChat = Boolean(raw.allowDeadChat);
  next.autoAdvance = raw.autoAdvance !== false;
  return next;
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function playerList(room, viewerId) {
  return [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    alive: player.alive,
    connected: player.connected,
    spectator: player.spectator,
    isHost: player.id === room.hostId,
    isYou: player.id === viewerId,
    role: shouldRevealRole(room, player, viewerId) ? player.role : null,
    votedByYou: room.phase === "day" ? room.dayVotes.get(viewerId) === player.id : false,
    actedByYou: didActOn(room, viewerId, player.id),
  }));
}

function shouldRevealRole(room, player, viewerId) {
  return room.phase === "lobby" || room.phase === "ended" || player.id === viewerId || (room.settings.revealOnDeath && !player.alive);
}

function didActOn(room, viewerId, targetId) {
  const viewer = room.players.get(viewerId);
  if (!viewer || room.phase !== "night") return false;
  return room.nightActions[viewer.role]?.get(viewerId) === targetId;
}

function publicVotes(room) {
  if (room.phase === "day") return [...room.dayVotes.entries()].map(([from, target]) => ({ from, target }));
  if (room.phase !== "night") return [];
  const entries = [];
  for (const [role, votes] of Object.entries(room.nightActions)) {
    for (const [from, target] of votes.entries()) entries.push({ from, target, role });
  }
  return entries;
}

function selectedSkip(room, viewerId) {
  const viewer = room.players.get(viewerId);
  if (!viewer) return false;
  if (room.phase === "day") return room.dayVotes.get(viewerId) === "skip";
  if (room.phase === "night") return room.nightActions[viewer.role]?.get(viewerId) === "skip";
  return false;
}

function activePlayers(room) {
  return [...room.players.values()].filter((player) => player.alive && !player.spectator);
}

function nightActors(room) {
  return activePlayers(room).filter((player) => player.connected && ["mafia", "doctor", "detective"].includes(player.role));
}

function phaseProgress(room) {
  if (room.phase === "day") {
    const eligible = activePlayers(room).filter((player) => player.connected);
    return {
      needed: eligible.length,
      done: eligible.filter((player) => room.dayVotes.has(player.id)).length,
      ready: eligible.length > 0 && eligible.every((player) => room.dayVotes.has(player.id)),
      label: "낮 투표",
    };
  }
  if (room.phase === "night") {
    const eligible = nightActors(room);
    return {
      needed: eligible.length,
      done: eligible.filter((player) => room.nightActions[player.role]?.has(player.id)).length,
      ready: eligible.length === 0 || eligible.every((player) => room.nightActions[player.role]?.has(player.id)),
      label: "밤 행동",
    };
  }
  return { needed: 0, done: 0, ready: false, label: "대기" };
}

function createFootballState() {
  const teams = randomFootballTeams();
  return {
    phase: "idle",
    teams,
    score: [0, 0],
    events: [],
    betsOpenUntil: 0,
    winner: null,
    winnerText: "",
    matchId: makeId(4),
  };
}

function randomFootballTeams() {
  return FOOTBALL_TEAMS[Math.floor(Math.random() * FOOTBALL_TEAMS.length)].slice();
}

function footballState(room, viewerId) {
  const bets = [...room.footballBets.values()];
  const homeTotal = bets.filter((bet) => bet.side === "home").reduce((sum, bet) => sum + bet.amount, 0);
  const awayTotal = bets.filter((bet) => bet.side === "away").reduce((sum, bet) => sum + bet.amount, 0);
  const myBet = room.footballBets.get(viewerId) || null;
  return {
    ...room.football,
    wallet: room.footballWallets.get(viewerId) ?? FOOTBALL_START_COINS,
    myBet,
    totals: { home: homeTotal, away: awayTotal },
    betCount: bets.length,
    leaders: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      coins: room.footballWallets.get(player.id) ?? FOOTBALL_START_COINS,
      connected: player.connected,
    })).sort((a, b) => b.coins - a.coins).slice(0, 8),
  };
}

function miniState(room, viewerId) {
  return {
    wallet: room.footballWallets.get(viewerId) ?? FOOTBALL_START_COINS,
    events: room.miniEvents || [],
    games: [
      { id: "coin", label: "동전 맞히기", choices: ["front", "back"] },
      { id: "dice", label: "주사위 홀짝", choices: ["odd", "even"] },
      { id: "number", label: "1~5 숫자", choices: ["1", "2", "3", "4", "5"] },
      { id: "roulette", label: "룰렛 색상", choices: ["red", "black", "green"] },
    ],
  };
}

function maybeAutoAdvance(room) {
  if (room.phase === "ended") return false;
  const progress = phaseProgress(room);
  if (!progress.ready) return false;
  if (room.phase === "night") applyNight(room);
  else if (room.phase === "day") applyDay(room);
  return true;
}

function roomState(room, viewerId) {
  const me = room.players.get(viewerId);
  const viewerClient = clients.get(viewerId);
  const canReadDeadChat = Boolean(me && room.phase !== "lobby" && !me.alive && !me.spectator);
  return {
    code: room.code,
    mode: room.mode,
    phase: room.phase,
    day: room.day,
    hostId: room.hostId,
    winner: room.winner,
    winnerText: room.winnerText,
    settings: room.settings,
    roleInfo: ROLE_INFO,
    account: publicUser(users.get(viewerClient?.userId)),
    you: me ? { id: me.id, name: me.name, role: me.role, alive: me.alive, connected: me.connected, spectator: me.spectator } : null,
    players: playerList(room, viewerId),
    votes: publicVotes(room),
    progress: phaseProgress(room),
    selectedSkip: selectedSkip(room, viewerId),
    messages: room.messages.slice(-80),
    deadMessages: canReadDeadChat ? room.deadMessages.slice(-80) : [],
    canUseDeadChat: Boolean(me && room.phase !== "lobby" && !me.alive && !me.spectator),
    log: room.log.slice(-40),
    event: room.events.at(-1) || null,
    football: footballState(room, viewerId),
    mini: miniState(room, viewerId),
    notices: room.privateNotices.get(viewerId)?.slice(-12) || [],
    deadPlayers: [...room.players.values()].filter((player) => !player.alive).map((player) => ({ id: player.id, name: player.name })),
  };
}

function send(socket, payload) {
  if (!socket || socket.destroyed || !socket.writable) return;
  const body = Buffer.from(JSON.stringify(payload));
  const header = [0x81];
  if (body.length < 126) {
    header.push(body.length);
  } else if (body.length < 65536) {
    header.push(126, body.length >> 8, body.length & 255);
  } else {
    const length = BigInt(body.length);
    header.push(127, ...Buffer.from([
      Number((length >> 56n) & 255n),
      Number((length >> 48n) & 255n),
      Number((length >> 40n) & 255n),
      Number((length >> 32n) & 255n),
      Number((length >> 24n) & 255n),
      Number((length >> 16n) & 255n),
      Number((length >> 8n) & 255n),
      Number(length & 255n),
    ]));
  }
  socket.write(Buffer.concat([Buffer.from(header), body]));
}

function broadcast(room) {
  touch(room);
  for (const player of room.players.values()) {
    const client = clients.get(player.id);
    if (client?.socket) send(client.socket, { type: "state", state: roomState(room, player.id) });
  }
}

function removePlayerFromLobby(room, id) {
  if (!room.players.has(id) || room.phase !== "lobby") return;
  const player = room.players.get(id);
  if (player.connected) return;
  leaveRoom(room, id, "disconnect");
}

function leaveRoom(room, id, reason = "leave") {
  if (!room.players.has(id)) return false;
  const player = room.players.get(id);
  room.players.delete(id);
  room.dayVotes.delete(id);
  room.footballBets.delete(id);
  room.footballDirectActions.delete(id);
  room.footballWallets.delete(id);
  for (const targetVotes of Object.values(room.nightActions)) targetVotes.delete(id);
  for (const [from, target] of [...room.dayVotes.entries()]) {
    if (target === id) room.dayVotes.delete(from);
  }
  for (const targetVotes of Object.values(room.nightActions)) {
    for (const [from, target] of [...targetVotes.entries()]) {
      if (target === id) targetVotes.delete(from);
    }
  }
  room.privateNotices.delete(id);
  if (room.disconnectTimers.has(id)) {
    clearTimeout(room.disconnectTimers.get(id));
    room.disconnectTimers.delete(id);
  }
  addLog(room, reason === "disconnect" ? `${player.name} 님이 연결 종료로 방을 나갔습니다.` : `${player.name} 님이 방을 나갔습니다.`);
  if (room.hostId === id) {
    const nextHost = [...room.players.values()].find((p) => p.connected)?.id || [...room.players.keys()][0] || null;
    room.hostId = nextHost;
    if (nextHost) addLog(room, `${room.players.get(nextHost).name} 님이 새 방장이 되었습니다.`);
  }
  if (room.players.size === 0 || !room.hostId) {
    rooms.delete(room.code);
  } else {
    checkWin(room);
    broadcast(room);
  }
  return true;
}

function addLog(room, text, level = "info") {
  room.log.push({ text, level, at: Date.now() });
  if (room.log.length > 120) room.log.splice(0, room.log.length - 120);
}

function addEvent(room, kind, title, text, tone = "info") {
  room.events.push({ id: makeId(4), kind, title, text, tone, at: Date.now() });
  if (room.events.length > 40) room.events.splice(0, room.events.length - 40);
}

function addMessage(room, from, text, system = false) {
  const clean = cleanText(text);
  if (!clean) return;
  room.messages.push({ from, text: clean, system, at: Date.now() });
  if (room.messages.length > 180) room.messages.splice(0, room.messages.length - 180);
}

function addDeadMessage(room, from, text) {
  const clean = cleanText(text);
  if (!clean) return;
  room.deadMessages.push({ from, text: clean, at: Date.now() });
  if (room.deadMessages.length > 180) room.deadMessages.splice(0, room.deadMessages.length - 180);
}

function addNotice(room, playerId, text) {
  const list = room.privateNotices.get(playerId) || [];
  list.push({ text, at: Date.now() });
  room.privateNotices.set(playerId, list.slice(-20));
}

function clearFootballTimers(room) {
  for (const timer of room.footballTimers) clearTimeout(timer);
  room.footballTimers = [];
}

function addFootballEvent(room, text, level = "info") {
  room.football.events.push({ text, level, at: Date.now() });
  if (room.football.events.length > 16) room.football.events.splice(0, room.football.events.length - 16);
}

function addMiniEvent(room, text, level = "info") {
  room.miniEvents = room.miniEvents || [];
  room.miniEvents.push({ text, level, at: Date.now() });
  if (room.miniEvents.length > 20) room.miniEvents.splice(0, room.miniEvents.length - 20);
}

function playMiniGame(room, player, game, choice, amount) {
  if (room.mode !== "mini") return false;
  const wallet = room.footballWallets.get(player.id) ?? FOOTBALL_START_COINS;
  const safeAmount = clampInt(amount, 10, Math.max(10, wallet));
  if (safeAmount > wallet) return false;

  let result = "";
  let win = false;
  let multiplier = 2;
  const pick = String(choice || "");

  if (game === "coin") {
    result = Math.random() < 0.5 ? "front" : "back";
    win = pick === result;
  } else if (game === "dice") {
    const roll = 1 + Math.floor(Math.random() * 6);
    result = roll % 2 ? "odd" : "even";
    win = pick === result;
  } else if (game === "number") {
    const roll = String(1 + Math.floor(Math.random() * 5));
    result = roll;
    win = pick === result;
    multiplier = 5;
  } else if (game === "roulette") {
    const roll = Math.random();
    result = roll < 0.47 ? "red" : roll < 0.94 ? "black" : "green";
    win = pick === result;
    multiplier = result === "green" ? 10 : 2;
  } else {
    return false;
  }

  const payout = win ? safeAmount * multiplier : 0;
  const nextWallet = wallet - safeAmount + payout;
  room.footballWallets.set(player.id, nextWallet);
  saveFootballCoins(player.accountId, nextWallet);
  const gameNames = { coin: "동전", dice: "주사위", number: "숫자", roulette: "룰렛" };
  addMiniEvent(room, `${player.name}: ${gameNames[game] || game} ${safeAmount}P 베팅, 선택 ${pick}, 결과 ${result} - ${win ? `${payout}P 획득` : "실패"}`, win ? "success" : "danger");
  return true;
}

function submitFeedback(client, text) {
  const user = users.get(client.userId);
  if (!user) return false;
  const body = cleanText(text, 600);
  if (body.length < 2) return false;
  const item = {
    id: makeId(6),
    userId: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    text: body,
    at: Date.now(),
  };
  feedbacks.push(item);
  saveFeedbacks();
  for (const other of clients.values()) {
    if (isAdminClient(other)) send(other.socket, { type: "adminFeedback", feedbacks: feedbacks.slice(-30), latest: item });
  }
  return true;
}

function startFootballBetting(room) {
  if (room.football.phase === "betting" || room.football.phase === "running") return false;
  clearFootballTimers(room);
  room.mode = "football";
  room.phase = "lobby";
  room.winner = null;
  room.winnerText = "";
  room.football = createFootballState();
  room.football.phase = "betting";
  room.football.betsOpenUntil = Date.now() + FOOTBALL_BET_MS;
  room.footballBets.clear();
  room.footballDirectActions.clear();
  addFootballEvent(room, `${room.football.teams[0]} vs ${room.football.teams[1]} 베팅이 열렸습니다.`, "phase");
  addEvent(room, "football-bet", "AI 축구 베팅", "12초 안에 이길 팀을 골라 베팅하세요.", "vote");
  addLog(room, "AI 축구 베팅이 시작되었습니다.", "phase");
  room.footballTimers.push(setTimeout(() => runFootballMatch(room.code, room.football.matchId), FOOTBALL_BET_MS));
  return true;
}

function startDirectFootball(room) {
  if (room.football.phase === "running") return false;
  clearFootballTimers(room);
  room.mode = "directFootball";
  room.phase = "lobby";
  room.winner = null;
  room.winnerText = "";
  room.football = createFootballState();
  room.football.phase = "running";
  room.football.betsOpenUntil = 0;
  room.footballBets.clear();
  room.footballDirectActions.clear();
  const players = [...room.players.values()];
  players.forEach((player, index) => {
    player.directTeam = index % 2 === 0 ? "home" : "away";
  });
  const humanCount = players.length;
  const aiCount = Math.max(0, 8 - humanCount);
  room.football.aiPlayers = Array.from({ length: aiCount }, (_, index) => ({
    name: `AI 선수 ${index + 1}`,
    side: index % 2 === 0 ? "home" : "away",
  }));
  addFootballEvent(room, `직접 축구 시작. 실제 참가자 ${humanCount}명, AI ${aiCount}명이 빈자리를 채웁니다.`, "phase");
  addEvent(room, "football-start", "직접 축구", "직접 슈팅과 수비 지시로 경기가 진행됩니다.", "success");
  room.footballTimers.push(setTimeout(() => {
    addFootballEvent(room, "중원에서 압박이 강해졌고 AI 선수들이 측면을 벌려 공격 루트를 만듭니다.", "info");
    broadcast(room);
  }, 1200));
  room.footballTimers.push(setTimeout(() => {
    addFootballEvent(room, "골키퍼가 긴 패스를 뿌렸고, 공격수가 뒷공간으로 침투합니다.", "info");
    broadcast(room);
  }, 2600));
  room.footballTimers.push(setTimeout(() => finishFootballMatch(room.code, room.football.matchId), 16000));
  return true;
}

function placeFootballBet(room, player, side, amount) {
  if (room.mode !== "football" || room.football.phase !== "betting") return false;
  if (!["home", "away"].includes(side)) return false;
  const wallet = room.footballWallets.get(player.id) ?? FOOTBALL_START_COINS;
  const existing = room.footballBets.get(player.id);
  const available = wallet + (existing?.amount || 0);
  const safeAmount = clampInt(amount, 10, Math.max(10, available));
  if (safeAmount > available) return false;
  const nextWallet = available - safeAmount;
  room.footballWallets.set(player.id, nextWallet);
  saveFootballCoins(player.accountId, nextWallet);
  room.footballBets.set(player.id, { playerId: player.id, name: player.name, side, amount: safeAmount });
  addFootballEvent(room, `${player.name} 님이 ${side === "home" ? room.football.teams[0] : room.football.teams[1]}에 ${safeAmount}포인트 베팅했습니다.`, "bet");
  return true;
}

function runFootballMatch(code, matchId) {
  const room = rooms.get(code);
  if (!room || room.mode !== "football" || room.football.matchId !== matchId || room.football.phase !== "betting") return;
  room.football.phase = "running";
  room.football.betsOpenUntil = 0;
  addFootballEvent(room, "킥오프! AI 선수들이 경기를 시작했습니다.", "phase");
  addEvent(room, "football-start", "킥오프", `${room.football.teams[0]} vs ${room.football.teams[1]} 경기가 시작됐습니다.`, "success");
  broadcast(room);

  const [home, away] = room.football.teams;
  const moments = shuffle([
    `${home}의 2선 미드필더가 전방 압박을 풀고 침투 패스를 찔러 넣습니다.`,
    `${away} 골키퍼가 각도를 좁히며 낮게 깔린 슈팅을 쳐냅니다.`,
    `${home} 윙어가 터치라인을 따라 질주한 뒤 박스 안으로 날카로운 크로스를 올립니다.`,
    `${away} 수비수가 몸을 던져 컷백 패스를 끊어냅니다. 위험한 장면이었습니다.`,
    `${away}가 짧은 패스 4번으로 중원을 통과합니다. 관중석이 술렁입니다.`,
    `${home} 스트라이커가 수비 뒷공간으로 빠져나가며 1대1 찬스를 만듭니다.`,
    `심판이 어드밴티지를 선언합니다. 경기가 끊기지 않고 빠르게 이어집니다.`,
    `${away}의 코너킥, 니어포스트로 쇄도했지만 헤더가 골문을 살짝 벗어납니다.`,
  ]).slice(0, 5);
  moments.forEach((text, index) => {
    room.footballTimers.push(setTimeout(() => {
      const current = rooms.get(code);
      if (!current || current.football.matchId !== matchId || current.football.phase !== "running") return;
      addFootballEvent(current, text, "info");
      broadcast(current);
    }, 900 + index * 900));
  });
  room.footballTimers.push(setTimeout(() => finishFootballMatch(code, matchId), 5000));
}

function footballDirectPlay(room, player, move) {
  if (!["football", "directFootball"].includes(room.mode) || room.football.phase !== "running") return false;
  const used = room.footballDirectActions.get(player.id) || 0;
  if (used >= 4) return false;
  const bet = room.footballBets.get(player.id);
  const side = player.directTeam || bet?.side || (Math.random() > 0.5 ? "home" : "away");
  const index = side === "home" ? 0 : 1;
  const team = room.football.teams[index];
  room.footballDirectActions.set(player.id, used + 1);
  if (move === "shoot" && Math.random() < 0.3) {
    room.football.score[index] += 1;
    addFootballEvent(room, `${player.name} 님이 타이밍을 잡아 직접 슈팅 지시! 공이 골키퍼 손끝을 스치고 들어갑니다. ${team} 득점!`, "success");
    addEvent(room, "football-goal", "GOAL", `${team} 득점! ${player.name} 님의 직접 슈팅 지시가 통했습니다.`, "success");
  } else if (move === "defend" && Math.random() < 0.45) {
    addFootballEvent(room, `${player.name} 님의 직접 수비 지시! 센터백이 라인을 맞추며 상대 침투를 오프사이드로 몰아넣었습니다.`, "phase");
  } else {
    addFootballEvent(room, `${player.name} 님이 직접 ${move === "shoot" ? "슈팅" : "수비"}를 지시했지만 타이밍이 조금 늦었습니다.`, "info");
  }
  return true;
}

function finishFootballMatch(code, matchId) {
  const room = rooms.get(code);
  if (!room || !["football", "directFootball"].includes(room.mode) || room.football.matchId !== matchId || room.football.phase !== "running") return;
  room.football.score[0] += Math.floor(Math.random() * 3);
  room.football.score[1] += Math.floor(Math.random() * 3);
  if (room.football.score[0] === room.football.score[1]) room.football.score[Math.random() > 0.5 ? 0 : 1] += 1;
  const winnerSide = room.football.score[0] > room.football.score[1] ? "home" : "away";
  const winnerIndex = winnerSide === "home" ? 0 : 1;
  room.football.phase = "finished";
  room.football.winner = winnerSide;
  room.football.winnerText = `${room.football.teams[winnerIndex]} 승리`;

  const totalPool = [...room.footballBets.values()].reduce((sum, bet) => sum + bet.amount, 0);
  const winningPool = [...room.footballBets.values()].filter((bet) => bet.side === winnerSide).reduce((sum, bet) => sum + bet.amount, 0);
  if (room.mode === "football") {
    const losingPool = Math.max(0, totalPool - winningPool);
    for (const bet of room.footballBets.values()) {
      if (bet.side !== winnerSide) continue;
      const payout = winningPool > 0 ? bet.amount + Math.floor((bet.amount / winningPool) * losingPool) : bet.amount;
      const nextCoins = (room.footballWallets.get(bet.playerId) ?? 0) + payout;
      room.footballWallets.set(bet.playerId, nextCoins);
      saveFootballCoins(room.players.get(bet.playerId)?.accountId, nextCoins);
    }
  }

  const result = `${room.football.teams[0]} ${room.football.score[0]} : ${room.football.score[1]} ${room.football.teams[1]}`;
  addFootballEvent(room, `${result}. ${room.football.winnerText}!`, "success");
  addEvent(room, "football-result", "경기 종료", `${result}. ${room.football.winnerText}!`, winnerSide === "home" ? "success" : "night");
  addLog(room, `AI 축구 경기 종료: ${result}.`, "success");
  broadcast(room);
}

function assignRoles(room) {
  const players = shuffle([...room.players.values()]);
  const counts = roleCounts(room.settings);
  const roles = [
    ...Array(counts.mafia).fill("mafia"),
    ...Array(counts.detective).fill("detective"),
    ...Array(counts.doctor).fill("doctor"),
    ...Array(counts.joker).fill("joker"),
  ];
  while (roles.length < players.length) roles.push("citizen");
  shuffle(roles);
  players.forEach((player, index) => {
    player.role = roles[index];
    player.alive = true;
    player.spectator = false;
    player.connected = true;
  });
  clearActions(room);
  room.privateNotices.clear();
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function clearActions(room) {
  room.dayVotes.clear();
  for (const votes of Object.values(room.nightActions)) votes.clear();
}

function alivePlayers(room) {
  return [...room.players.values()].filter((player) => player.alive);
}

function checkWin(room) {
  if (room.phase === "ended" || room.winner) return true;
  const alive = activePlayers(room);
  const mafia = alive.filter((player) => player.role === "mafia").length;
  const nonMafia = alive.length - mafia;
  if (mafia === 0) {
    room.phase = "ended";
    room.winner = "citizens";
    room.winnerText = "시민 팀 승리";
    addLog(room, "마피아가 모두 사라져 시민 팀이 승리했습니다.", "success");
    return true;
  }
  if (mafia >= nonMafia) {
    room.phase = "ended";
    room.winner = "mafia";
    room.winnerText = "마피아 팀 승리";
    addLog(room, "마피아 수가 시민 수 이상이 되어 마피아 팀이 승리했습니다.", "danger");
    return true;
  }
  return false;
}

function tallyMap(votes) {
  const counts = new Map();
  for (const targetId of votes.values()) counts.set(targetId, (counts.get(targetId) || 0) + 1);
  let bestId = null;
  let best = 0;
  let tied = false;
  for (const [id, count] of counts.entries()) {
    if (count > best) {
      bestId = id;
      best = count;
      tied = false;
    } else if (count === best) {
      tied = true;
    }
  }
  if (tied || bestId === "skip") return null;
  return bestId;
}

function applyNight(room) {
  const mafiaTargetId = tallyMap(room.nightActions.mafia);
  const protectedIds = new Set(room.nightActions.doctor.values());
  const detectiveActions = [...room.nightActions.detective.entries()];

  for (const [detectiveId, targetId] of detectiveActions) {
    const target = room.players.get(targetId);
    if (target) addNotice(room, detectiveId, `${target.name} 님은 ${target.role === "mafia" ? "마피아입니다" : "마피아가 아닙니다"}.`);
  }

  if (!mafiaTargetId) {
    addLog(room, "밤에 아무도 습격당하지 않았습니다.");
    addEvent(room, "night-skip", "밤이 조용히 지나갔습니다", "마피아가 아무도 습격하지 않았습니다.", "night");
  } else if (protectedIds.has(mafiaTargetId)) {
    addLog(room, "의사가 마피아의 습격을 막았습니다.", "success");
    addEvent(room, "saved", "의사가 살렸습니다", "마피아의 습격이 의사에게 막혔습니다.", "success");
  } else {
    eliminate(room, mafiaTargetId, "night");
  }

  clearActions(room);
  if (!checkWin(room)) {
    room.phase = "day";
    room.day += 1;
    addLog(room, `${room.day}일차 낮입니다. 토론하고 투표하세요.`, "phase");
  }
}

function applyDay(room) {
  const targetId = tallyMap(room.dayVotes);
  if (!targetId) {
    addLog(room, "낮 투표 결과 아무도 처형되지 않았습니다.");
    addEvent(room, "vote-skip", "투표 결과", "아무도 처형되지 않았습니다.", "vote");
  } else {
    const target = room.players.get(targetId);
    if (target?.alive && target.role === "joker") {
      target.alive = false;
      room.phase = "ended";
      room.winner = "joker";
      room.winnerText = `${target.name} 조커 승리`;
      addLog(room, `${target.name} 님이 투표로 처형되어 조커가 승리했습니다.`, "joker");
      addEvent(room, "joker", "조커 승리", `${target.name} 님이 투표로 처형되었습니다. 역할: ${roleLabel(target.role)}. 조커가 승리했습니다.`, "joker");
    } else {
      eliminate(room, targetId, "vote");
    }
  }
  clearActions(room);
  if (!checkWin(room)) {
    room.phase = "night";
    addLog(room, "밤이 되었습니다. 역할이 있는 플레이어는 대상을 선택하세요.", "phase");
  }
}

function eliminate(room, targetId, reason) {
  const target = room.players.get(targetId);
  if (!target || !target.alive) return;
  target.alive = false;
  const reasonText = reason === "vote" ? "투표로 처형되었습니다" : "밤에 습격당했습니다";
  const roleText = roleLabel(target.role);
  addLog(room, `${target.name} 님이 ${reasonText}. 역할: ${roleText}.`, reason === "vote" ? "danger" : "night");
  addEvent(
    room,
    reason === "vote" ? "execution" : "murder",
    reason === "vote" ? "처형" : "밤의 사건",
    `${target.name} 님이 ${reasonText}. 역할: ${roleText}.`,
    reason === "vote" ? "danger" : "night",
  );
}

function canTarget(player, target, phase) {
  if (!player || !target || !player.alive || player.spectator || target.spectator) return false;
  if (phase === "day") return target.alive;
  if (phase !== "night") return false;
  return target.alive;
}

function handleAction(id, message) {
  const client = clients.get(id);
  if (!client) return;
  let room = client.roomCode ? rooms.get(client.roomCode) : null;
  const data = message || {};

  if (data.action === "usernameCheck") {
    const username = normalizeUsername(data.username);
    if (username.length < 2) return send(client.socket, { type: "usernameCheck", ok: false, message: "아이디는 2글자 이상이어야 합니다." });
    const exists = [...users.values()].some((item) => item.username.toLowerCase() === username.toLowerCase());
    return send(client.socket, {
      type: "usernameCheck",
      ok: !exists,
      username,
      message: exists ? "이미 사용 중인 아이디입니다." : "사용 가능한 아이디입니다.",
    });
  }

  if (data.action === "authRegister" || data.action === "authLogin") {
    const username = normalizeUsername(data.username);
    const password = String(data.password || "");
    if (username.length < 2 || password.length < 4) return send(client.socket, { type: "error", message: "아이디는 2글자 이상, 비밀번호는 4글자 이상이어야 합니다." });
    let user = [...users.values()].find((item) => item.username.toLowerCase() === username.toLowerCase());
    if (data.action === "authRegister") {
      if (user) return send(client.socket, { type: "error", message: "이미 있는 아이디입니다." });
      const adminNames = String(process.env.ADMIN_USERS || "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
      user = {
        id: makeId(8),
        username,
        displayName: normalizeDisplayName(data.displayName, username),
        passwordHash: passwordHash(password),
        footballCoins: FOOTBALL_START_COINS,
        isAdmin: adminNames.includes(username.toLowerCase()),
        createdAt: Date.now(),
      };
      users.set(user.id, user);
      saveUsers();
    } else if (!user || !verifyPassword(password, user.passwordHash)) {
      return send(client.socket, { type: "error", message: "아이디 또는 비밀번호가 맞지 않습니다." });
    }
    client.userId = user.id;
    const token = createSession(user.id);
    return send(client.socket, { type: "auth", user: publicUser(user), token: data.remember ? token : null, sessionToken: token });
  }

  if (data.action === "profileUpdate") {
    const user = users.get(client.userId);
    if (!user) return send(client.socket, { type: "error", message: "먼저 로그인하세요." });
    const displayName = normalizeDisplayName(data.displayName, user.displayName || user.username);
    if (displayName.length < 2) return send(client.socket, { type: "error", message: "표시 이름은 2글자 이상이어야 합니다." });
    user.displayName = displayName;
    const newPassword = String(data.newPassword || "");
    if (newPassword) {
      if (newPassword.length < 4) return send(client.socket, { type: "error", message: "새 비밀번호는 4글자 이상이어야 합니다." });
      if (!verifyPassword(String(data.currentPassword || ""), user.passwordHash)) return send(client.socket, { type: "error", message: "현재 비밀번호가 맞지 않습니다." });
      user.passwordHash = passwordHash(newPassword);
    }
    users.set(user.id, user);
    saveUsers();
    for (const roomToUpdate of rooms.values()) {
      for (const playerToUpdate of roomToUpdate.players.values()) {
        if (playerToUpdate.accountId === user.id) playerToUpdate.name = displayName;
      }
      broadcast(roomToUpdate);
    }
    return send(client.socket, { type: "auth", user: publicUser(user), sessionToken: createSession(user.id) });
  }

  if (data.action === "feedbackSubmit") {
    if (!submitFeedback(client, data.text)) return send(client.socket, { type: "error", message: "피드백 내용을 입력하세요." });
    return send(client.socket, { type: "toast", message: "피드백이 관리자에게 전달되었습니다." });
  }

  if (data.action === "feedbackList") {
    if (!isAdminClient(client)) return;
    return send(client.socket, { type: "adminFeedback", feedbacks: feedbacks.slice(-30) });
  }

  if (data.action === "authRestore") {
    const userId = sessions.get(String(data.token || ""));
    const user = userId ? users.get(userId) : null;
    if (!user) return send(client.socket, { type: "auth", user: null });
    client.userId = user.id;
    return send(client.socket, { type: "auth", user: publicUser(user), token: data.token });
  }

  if (data.action === "authLogout") {
    client.userId = null;
    client.roomCode = null;
    return send(client.socket, { type: "auth", user: null });
  }

  if (data.action === "create") {
    const name = authName(client);
    if (!name) return send(client.socket, { type: "error", message: "먼저 로그인하세요." });
    const newRoom = createRoom(id, name, data.mode, client.userId);
    client.roomCode = newRoom.code;
    return broadcast(newRoom);
  }

  if (data.action === "join") {
    const code = String(data.code || "").trim().toUpperCase();
    room = rooms.get(code);
    if (!room) return send(client.socket, { type: "error", message: "방 코드를 찾을 수 없습니다." });
    if (room.players.size >= MAX_PLAYERS) return send(client.socket, { type: "error", message: "방 인원이 가득 찼습니다." });
    const name = authName(client);
    if (!name) return send(client.socket, { type: "error", message: "먼저 로그인하세요." });
    client.roomCode = code;
    const player = addPlayer(room, id, name, client.userId);
    player.connected = true;
    addLog(room, room.phase === "lobby" ? `${player.name} 님이 입장했습니다.` : `${player.name} 님이 관전자로 입장했습니다.`);
    return broadcast(room);
  }

  if (!room || !room.players.has(id)) return send(client.socket, { type: "error", message: "먼저 방을 만들거나 입장하세요." });
  touch(room);
  const player = room.players.get(id);
  const canManageRoom = room.hostId === id || isAdminClient(client);

  if (data.action === "settings") {
    if (!canManageRoom || room.phase !== "lobby") return;
    room.settings = sanitizeSettings(data.settings, room.players.size);
    addLog(room, "방 설정이 변경되었습니다.");
  } else if (data.action === "mode") {
    if (!canManageRoom || room.phase !== "lobby") return;
    const nextMode = normalizeMode(data.mode);
    if (room.mode !== nextMode) {
      clearFootballTimers(room);
      room.mode = nextMode;
      room.football.phase = "idle";
      room.football.betsOpenUntil = 0;
      room.footballBets.clear();
      room.miniEvents = [];
      addLog(room, nextMode === "football" ? "게임 모드가 AI 축구 베팅으로 변경되었습니다." : "게임 모드가 마피아로 변경되었습니다.", "phase");
    }
  } else if (data.action === "start") {
    if (!canManageRoom) return;
    if (room.mode === "football") {
      if (!startFootballBetting(room)) return send(client.socket, { type: "error", message: "이미 경기가 진행 중입니다." });
      return broadcast(room);
    }
    if (room.mode === "directFootball") {
      if (!startDirectFootball(room)) return send(client.socket, { type: "error", message: "이미 경기가 진행 중입니다." });
      return broadcast(room);
    }
    if (room.mode === "mini") return;
    const min = Math.max(3, specialRoleTotal(room.settings));
    if (room.players.size < min) return send(client.socket, { type: "error", message: `현재 설정으로는 최소 ${min}명이 필요합니다.` });
    room.settings = sanitizeSettings(room.settings, room.players.size);
    assignRoles(room);
    room.phase = "night";
    room.day = 0;
    room.winner = null;
    room.winnerText = "";
    room.messages = [];
    room.deadMessages = [];
    addLog(room, "게임이 시작되었습니다. 첫 밤입니다.", "phase");
    maybeAutoAdvance(room);
  } else if (data.action === "vote") {
    if (room.mode !== "mafia") return;
    const isSkip = data.target === "skip";
    const target = isSkip ? { id: "skip", alive: true, spectator: false } : room.players.get(data.target);
    if ((!isSkip && !canTarget(player, target, room.phase)) || room.phase === "ended" || room.phase === "lobby") return;
    if (room.phase === "day") {
      room.dayVotes.set(id, target.id);
      addLog(room, `${player.name} 님이 투표했습니다. (${phaseProgress(room).done}/${phaseProgress(room).needed})`);
    } else if (["mafia", "doctor", "detective"].includes(player.role)) {
      room.nightActions[player.role].set(id, target.id);
      if (!isSkip && player.role === "detective") addNotice(room, id, `${target.name} 님을 조사 대상으로 선택했습니다. 결과는 밤 종료 후 공개됩니다.`);
      addLog(room, `${roleLabel(player.role)} 행동이 등록되었습니다. (${phaseProgress(room).done}/${phaseProgress(room).needed})`);
    }
    maybeAutoAdvance(room);
  } else if (data.action === "footballBet") {
    if (!placeFootballBet(room, player, data.side, data.amount)) return send(client.socket, { type: "error", message: "지금은 베팅할 수 없습니다." });
  } else if (data.action === "footballPlay") {
    if (!footballDirectPlay(room, player, data.move)) return send(client.socket, { type: "error", message: "지금은 직접 플레이를 할 수 없습니다." });
  } else if (data.action === "miniPlay") {
    if (!playMiniGame(room, player, data.game, data.choice, data.amount)) return send(client.socket, { type: "error", message: "미니게임을 진행할 수 없습니다." });
  } else if (data.action === "chat") {
    if (data.channel === "dead") {
      if (room.phase !== "lobby" && !player.alive && !player.spectator) addDeadMessage(room, player.name, data.text);
    } else {
      const canSpeak = room.phase === "lobby" || room.phase === "day" || room.phase === "ended" || player.alive || player.spectator || room.settings.allowDeadChat;
      if (canSpeak) addMessage(room, player.name, data.text);
    }
  } else if (data.action === "reset") {
    if (!canManageRoom) return;
    resetRoom(room);
  } else if (data.action === "leave") {
    client.roomCode = null;
    leaveRoom(room, id, "leave");
    send(client.socket, { type: "left" });
    return;
  }
  broadcast(room);
}

function resetRoom(room) {
  clearFootballTimers(room);
  room.phase = "lobby";
  room.day = 0;
  room.winner = null;
  room.winnerText = "";
  clearActions(room);
  room.privateNotices.clear();
  room.deadMessages = [];
  room.events = [];
  room.football = createFootballState();
  room.footballBets.clear();
  room.footballDirectActions.clear();
  room.miniEvents = [];
  for (const player of room.players.values()) {
    player.role = null;
    player.alive = true;
    player.spectator = false;
  }
  addLog(room, "방장이 게임을 대기실로 되돌렸습니다.", "phase");
}

function decodeFrames(socket, buffer) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    if (length > 65536) return socket.destroy();
    const masked = Boolean(second & 0x80);
    if (masked && cursor + 4 > buffer.length) break;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += masked ? 4 : 0;
    if (cursor + length > buffer.length) break;
    const payload = buffer.subarray(cursor, cursor + length);
    offset = cursor + length;
    if (opcode === 8) return socket.end();
    if (opcode === 9) {
      sendPong(socket, payload);
      continue;
    }
    if (opcode !== 1) continue;
    const data = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) data[i] = masked ? payload[i] ^ mask[i % 4] : payload[i];
    try {
      handleAction(socket.clientId, JSON.parse(data.toString("utf8")));
    } catch {
      send(socket, { type: "error", message: "메시지를 처리하지 못했습니다." });
    }
  }
  socket.leftover = buffer.subarray(offset);
}

function sendPong(socket, payload) {
  if (!socket.writable) return;
  socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size }));
  }
  if (url.pathname === "/meta") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(serverMeta(req)));
  }
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  if (String(req.headers.upgrade).toLowerCase() !== "websocket") return socket.destroy();
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedId = String(url.searchParams.get("sid") || "");
  const id = /^[a-f0-9]{16,40}$/i.test(requestedId) ? requestedId.slice(0, 40) : makeId();
  const previous = clients.get(id);
  if (previous?.socket && previous.socket !== socket) previous.socket.destroy();
  socket.clientId = id;
  socket.leftover = Buffer.alloc(0);
  clients.set(id, { socket, roomCode: previous?.roomCode || null, userId: previous?.userId || null });
  socket.on("data", (chunk) => decodeFrames(socket, Buffer.concat([socket.leftover, chunk])));
  socket.on("error", () => {});
  socket.on("close", () => disconnectClient(id, socket));
});

function disconnectClient(id, socket) {
  const client = clients.get(id);
  if (client?.socket && client.socket !== socket) return;
  const room = client?.roomCode ? rooms.get(client.roomCode) : null;
  clients.delete(id);
  if (!room?.players.has(id)) return;
  const player = room.players.get(id);
  player.connected = false;
  if (room.phase === "lobby") {
    if (room.disconnectTimers.has(id)) clearTimeout(room.disconnectTimers.get(id));
    room.disconnectTimers.set(id, setTimeout(() => {
      room.disconnectTimers.delete(id);
      removePlayerFromLobby(room, id);
    }, LOBBY_DISCONNECT_GRACE_MS));
  } else {
    addLog(room, `${player.name} 님의 연결이 끊겼습니다. 진행 중인 게임에서는 자리만 비활성화됩니다.`);
  }
  if (room.hostId === id) {
    const nextHost = [...room.players.values()].find((p) => p.connected)?.id || [...room.players.keys()][0] || null;
    room.hostId = nextHost;
    if (nextHost) addLog(room, `${room.players.get(nextHost).name} 님이 새 방장이 되었습니다.`);
  }
  if (room.players.size === 0 || !room.hostId) rooms.delete(room.code);
  else broadcast(room);
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActiveAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, 1000 * 60 * 10).unref();

server.listen(PORT, HOST, () => {
  console.log("Mafia Server");
  console.log(`Local: http://127.0.0.1:${PORT}`);
  console.log(`LAN:   ${publicAddress()}`);
  console.log("Press Ctrl+C to stop.");
});
