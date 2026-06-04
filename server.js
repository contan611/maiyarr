const http = require("http");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_PLAYERS = 24;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const LOBBY_DISCONNECT_GRACE_MS = 25000;

const rooms = new Map();
const clients = new Map();

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
  medium: {
    label: "영매사",
    team: "citizens",
    description: "밤마다 죽은 사람의 역할을 확인해 모두에게 힌트를 줍니다.",
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
  mediumCount: 0,
  jokerCount: 0,
  revealOnDeath: true,
  allowDeadChat: false,
  autoAdvance: true,
};

function makeId(bytes = 8) {
  return crypto.randomBytes(bytes).toString("hex");
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

function createRoom(hostId, hostName) {
  const code = makeRoomCode();
  const room = {
    code,
    hostId,
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
      medium: new Map(),
    },
    disconnectTimers: new Map(),
    privateNotices: new Map(),
    messages: [],
    deadMessages: [],
    log: [],
  };
  rooms.set(code, room);
  addPlayer(room, hostId, hostName);
  addLog(room, `${room.players.get(hostId).name} 님이 방을 만들었습니다.`);
  return room;
}

function addPlayer(room, id, name) {
  if (room.disconnectTimers.has(id)) {
    clearTimeout(room.disconnectTimers.get(id));
    room.disconnectTimers.delete(id);
  }
  if (room.players.has(id)) {
    const existing = room.players.get(id);
    existing.connected = true;
    if (name) existing.name = sanitizeName(name);
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
  };
  room.players.set(id, player);
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
    medium: clampInt(settings.mediumCount, 0, 4),
    joker: clampInt(settings.jokerCount, 0, 2),
  };
}

function specialRoleTotal(settings) {
  const counts = roleCounts(settings);
  return counts.mafia + counts.detective + counts.doctor + counts.medium + counts.joker;
}

function sanitizeSettings(input, playerCount) {
  const next = { ...DEFAULT_SETTINGS };
  const raw = input || {};
  next.mafiaCount = clampInt(raw.mafiaCount, 1, 8);
  next.detectiveCount = clampInt(raw.detectiveCount, 0, 4);
  next.doctorCount = clampInt(raw.doctorCount, 0, 4);
  next.mediumCount = clampInt(raw.mediumCount, 0, 4);
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
  return activePlayers(room).filter((player) => player.connected && ["mafia", "doctor", "detective", "medium"].includes(player.role));
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
    const eligible = nightActors(room).filter((player) => player.role !== "medium" || [...room.players.values()].some((target) => !target.alive));
    return {
      needed: eligible.length,
      done: eligible.filter((player) => room.nightActions[player.role]?.has(player.id)).length,
      ready: eligible.length === 0 || eligible.every((player) => room.nightActions[player.role]?.has(player.id)),
      label: "밤 행동",
    };
  }
  return { needed: 0, done: 0, ready: false, label: "대기" };
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
  const canReadDeadChat = Boolean(me && room.phase !== "lobby" && !me.alive && !me.spectator);
  return {
    code: room.code,
    phase: room.phase,
    day: room.day,
    hostId: room.hostId,
    winner: room.winner,
    winnerText: room.winnerText,
    settings: room.settings,
    roleInfo: ROLE_INFO,
    you: me ? { id: me.id, name: me.name, role: me.role, alive: me.alive, connected: me.connected, spectator: me.spectator } : null,
    players: playerList(room, viewerId),
    votes: publicVotes(room),
    progress: phaseProgress(room),
    selectedSkip: selectedSkip(room, viewerId),
    messages: room.messages.slice(-80),
    deadMessages: canReadDeadChat ? room.deadMessages.slice(-80) : [],
    canUseDeadChat: Boolean(me && room.phase !== "lobby" && !me.alive && !me.spectator),
    log: room.log.slice(-40),
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

function assignRoles(room) {
  const players = shuffle([...room.players.values()]);
  const counts = roleCounts(room.settings);
  const roles = [
    ...Array(counts.mafia).fill("mafia"),
    ...Array(counts.detective).fill("detective"),
    ...Array(counts.doctor).fill("doctor"),
    ...Array(counts.medium).fill("medium"),
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
  const mediumActions = [...room.nightActions.medium.entries()];

  for (const [detectiveId, targetId] of detectiveActions) {
    const target = room.players.get(targetId);
    if (target) addNotice(room, detectiveId, `${target.name} 님은 ${target.role === "mafia" ? "마피아입니다" : "마피아가 아닙니다"}.`);
  }

  for (const [, targetId] of mediumActions) {
    const target = room.players.get(targetId);
    if (target && !target.alive) addLog(room, `영매사의 힌트: ${target.name} 님의 역할은 ${roleLabel(target.role)}였습니다.`, "mystic");
  }

  if (!mafiaTargetId) {
    addLog(room, "밤에 아무도 습격당하지 않았습니다.");
  } else if (protectedIds.has(mafiaTargetId)) {
    addLog(room, "의사가 마피아의 습격을 막았습니다.", "success");
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
  } else {
    const target = room.players.get(targetId);
    if (target?.alive && target.role === "joker") {
      target.alive = false;
      room.phase = "ended";
      room.winner = "joker";
      room.winnerText = `${target.name} 조커 승리`;
      addLog(room, `${target.name} 님이 투표로 처형되어 조커가 승리했습니다.`, "joker");
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
  const reveal = room.settings.revealOnDeath ? ` 역할은 ${roleLabel(target.role)}입니다.` : "";
  addLog(room, `${target.name} 님이 ${reasonText}.${reveal}`, reason === "vote" ? "danger" : "night");
}

function canTarget(player, target, phase) {
  if (!player || !target || !player.alive || player.spectator || target.spectator) return false;
  if (phase === "day") return target.alive;
  if (phase !== "night") return false;
  if (player.role === "medium") return !target.alive;
  return target.alive;
}

function handleAction(id, message) {
  const client = clients.get(id);
  if (!client) return;
  let room = client.roomCode ? rooms.get(client.roomCode) : null;
  const data = message || {};

  if (data.action === "create") {
    const newRoom = createRoom(id, data.name);
    client.roomCode = newRoom.code;
    return broadcast(newRoom);
  }

  if (data.action === "join") {
    const code = String(data.code || "").trim().toUpperCase();
    room = rooms.get(code);
    if (!room) return send(client.socket, { type: "error", message: "방 코드를 찾을 수 없습니다." });
    if (room.players.size >= MAX_PLAYERS) return send(client.socket, { type: "error", message: "방 인원이 가득 찼습니다." });
    client.roomCode = code;
    const player = addPlayer(room, id, data.name);
    player.connected = true;
    addLog(room, room.phase === "lobby" ? `${player.name} 님이 입장했습니다.` : `${player.name} 님이 관전자로 입장했습니다.`);
    return broadcast(room);
  }

  if (!room || !room.players.has(id)) return send(client.socket, { type: "error", message: "먼저 방을 만들거나 입장하세요." });
  touch(room);
  const player = room.players.get(id);

  if (data.action === "settings") {
    if (room.hostId !== id || room.phase !== "lobby") return;
    room.settings = sanitizeSettings(data.settings, room.players.size);
    addLog(room, "방 설정이 변경되었습니다.");
  } else if (data.action === "start") {
    if (room.hostId !== id) return;
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
    const isSkip = data.target === "skip";
    const target = isSkip ? { id: "skip", alive: true, spectator: false } : room.players.get(data.target);
    if ((!isSkip && !canTarget(player, target, room.phase)) || room.phase === "ended" || room.phase === "lobby") return;
    if (room.phase === "day") {
      room.dayVotes.set(id, target.id);
      addLog(room, `${player.name} 님이 투표했습니다. (${phaseProgress(room).done}/${phaseProgress(room).needed})`);
    } else if (["mafia", "doctor", "detective", "medium"].includes(player.role)) {
      room.nightActions[player.role].set(id, target.id);
      if (!isSkip && player.role === "detective") addNotice(room, id, `${target.name} 님을 조사 대상으로 선택했습니다. 결과는 밤 종료 후 공개됩니다.`);
      if (!isSkip && player.role === "medium") addNotice(room, id, `${target.name} 님의 혼을 확인합니다. 힌트는 밤 종료 후 모두에게 공개됩니다.`);
      addLog(room, `${roleLabel(player.role)} 행동이 등록되었습니다. (${phaseProgress(room).done}/${phaseProgress(room).needed})`);
    }
    maybeAutoAdvance(room);
  } else if (data.action === "chat") {
    if (data.channel === "dead") {
      if (room.phase !== "lobby" && !player.alive && !player.spectator) addDeadMessage(room, player.name, data.text);
    } else {
      const canSpeak = room.phase === "lobby" || room.phase === "day" || room.phase === "ended" || player.alive || player.spectator || room.settings.allowDeadChat;
      if (canSpeak) addMessage(room, player.name, data.text);
    }
  } else if (data.action === "reset") {
    if (room.hostId !== id) return;
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
  room.phase = "lobby";
  room.day = 0;
  room.winner = null;
  room.winnerText = "";
  clearActions(room);
  room.privateNotices.clear();
  room.deadMessages = [];
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
  clients.set(id, { socket, roomCode: previous?.roomCode || null });
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
