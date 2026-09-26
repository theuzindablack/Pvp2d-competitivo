// --- CONFIGURAÇÕES & ESTADO ---
const TILE_SIZE = 32;
const CHUNK_SIZE = 16;
const CHUNK_PIXELS = CHUNK_SIZE * TILE_SIZE;

let worldData = {};
let globalDefaultSpawnPos = null;
let selectedTool = null;
let placeWithCollision = true;
let teamTouchEnabled = true;
let nextPlayerNumber = 1;
let projectiles = [];
let particles = [];
let playerInventory = [null, null, null];
let activeSlotIndex = -1;

let peer = null;
let isHost = false;
let connections = {};
let peerToPlayerId = {};
let hostConn = null;
let remotePlayers = {};

const localPlayer = {
  id: Math.random().toString(36).substr(2, 9),
  playerNumber: 1,
  x: 0,
  y: 0,
  hp: 100,
  size: 24,
  speed: 4,
  color: '#' + Math.floor(Math.random()*16777215).toString(16),
  team: null,
  isAdmin: false,
  bubble: null,
  equippedTool: null
};

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);

// --- PEERJS & REDE ---
function initHost(fixedId) {
  peer = new Peer(fixedId);

  peer.on('open', (id) => {
    isHost = true;
    localPlayer.playerNumber = 1;
    localPlayer.isAdmin = true;
    nextPlayerNumber = 2;
    document.getElementById('user-number').textContent = `#${localPlayer.playerNumber}`;
    document.getElementById('room-name').textContent = id;
    document.getElementById('net-status').textContent = "Sala Aberta (Host)";
    updateAdminUIState();
    document.getElementById('btn-exit-room').textContent = "🚪 FECHAR SALA";
    updateAndBroadcastPlayerCount();
    startGame();
  });

  peer.on('connection', (conn) => {
    const clientPeerId = conn.peer;
    connections[clientPeerId] = conn;

    conn.on('open', () => {
      document.getElementById('net-status').textContent = "Jogadores Conectados";
      const assignedNum = nextPlayerNumber++;
      
      conn.send({
        type: 'WORLD_SYNC',
        world: worldData,
        assignedNumber: assignedNum,
        globalDefaultSpawn: globalDefaultSpawnPos
      });
      addChatMessage(`Jogador #${assignedNum} entrou na sala!`, "msg-system");
    });

    conn.on('data', (data) => handleNetworkData(data, clientPeerId));
    conn.on('close', () => removeClient(clientPeerId));
    conn.on('error', () => removeClient(clientPeerId));
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') alert("Esta sala já foi criada!");
    else alert("Erro: " + err.type);
  });
}

function initClient(fixedId) {
  peer = new Peer();

  peer.on('open', () => {
    isHost = false;
    hostConn = peer.connect(fixedId);

    hostConn.on('open', () => {
      document.getElementById('room-name').textContent = fixedId;
      document.getElementById('net-status').textContent = "Conectado ao Host";
      updateAdminUIState();
      document.getElementById('btn-exit-room').textContent = "🚪 SAIR DA SALA";
      startGame();
    });

    hostConn.on('data', (data) => handleNetworkData(data));
    hostConn.on('close', () => {
      alert("A sala foi encerrada pelo Host!");
      resetToLobby();
    });
  });

  peer.on('error', (err) => alert("Erro ao conectar: " + err.type));
}

function broadcast(data, excludePlayerId = null) {
  if (!isHost) return;
  for (let peerId in connections) {
    if (connections[peerId].open) {
      const playerId = peerToPlayerId[peerId];
      if (playerId !== excludePlayerId) {
        connections[peerId].send(data);
      }
    }
  }
}

function handleNetworkData(data, clientPeerId = null) {
  if (data.type === 'POS') {
    if (clientPeerId) peerToPlayerId[clientPeerId] = data.id;
    if (data.id !== localPlayer.id) {
      remotePlayers[data.id] = remotePlayers[data.id] || {};
      Object.assign(remotePlayers[data.id], data);
    }
    if (isHost) broadcast(data, data.id);
  } else if (data.type === 'CHAT') {
    if (data.senderId !== localPlayer.id) {
      addChatMessage(`Player #${data.playerNumber || '?'}: ${data.msg}`, "msg-other");
      triggerSpeechBubble(data.senderId, data.msg);
    }
    if (isHost) broadcast(data, data.senderId);
  } else if (data.type === 'PLAYER_COUNT') {
    document.getElementById('player-count').textContent = data.count;
  } else if (data.type === 'PLAYER_LEAVE') {
    delete remotePlayers[data.id];
  } else if (data.type === 'WORLD_SYNC') {
    worldData = data.world;
    if (data.globalDefaultSpawn) globalDefaultSpawnPos = data.globalDefaultSpawn;
    if (data.assignedNumber) {
      localPlayer.playerNumber = data.assignedNumber;
      document.getElementById('user-number').textContent = `#${localPlayer.playerNumber}`;
    }
    respawnPlayer();
  } else if (data.type === 'BLOCK_UPDATE') {
    applyBlockChange(data.chunkKey, data.blockKey, data.blockData);
  } else if (data.type === 'SHOOT_HOMING') {
    spawnProjectile(data.x, data.y, data.targetId, data.senderId, data.senderTeam);
    if (isHost) broadcast(data, data.senderId);
  } else if (data.type === 'REMOVE_WORLD_ITEM') {
    applyBlockChange(data.chunkKey, data.blockKey, null);
    if (isHost) broadcast(data, data.senderId);
  } else if (data.type === 'SET_GLOBAL_SPAWN') {
    globalDefaultSpawnPos = data.spawn;
    if (isHost) broadcast(data, data.senderId);
  } else if (data.type === 'SET_ADMIN_ROLE') {
    if (data.targetNumber === localPlayer.playerNumber) {
      localPlayer.isAdmin = data.isAdmin;
      updateAdminUIState();
      addChatMessage(data.isAdmin ? "[Sistema] Você recebeu permissão de ADMIN!" : "[Sistema] Permissão de ADMIN removida.", "msg-system");
    }
  } else if (data.type === 'GIVE_ITEM_DIRECT') {
    if (data.targetNumber === localPlayer.playerNumber) {
      const added = addItemToInventory(data.item);
      addChatMessage(added ? `[Sistema] Item recebido de Player #${data.fromNumber}!` : `[Sistema] Inventário cheio!`, "msg-system");
    } else if (isHost) {
      broadcast(data, data.senderId);
    }
  } else if (data.type === 'BLOCK_UPDATE_REQUEST' && isHost) {
    if (remotePlayers[data.senderId]?.isAdmin) {
      applyBlockChange(data.chunkKey, data.blockKey, data.blockData);
      broadcast({ type: 'BLOCK_UPDATE', chunkKey: data.chunkKey, blockKey: data.blockKey, blockData: data.blockData });
    }
  } else if (data.type === 'GIVE_TOOLS_ALL' && isHost) {
    if (remotePlayers[data.senderId]?.isAdmin) giveItemToAllPlayers('homing_weapon');
  }
}

function removeClient(clientPeerId) {
  const playerId = peerToPlayerId[clientPeerId];
  if (playerId) {
    delete remotePlayers[playerId];
    delete peerToPlayerId[clientPeerId];
    broadcast({ type: 'PLAYER_LEAVE', id: playerId });
  }
  if (connections[clientPeerId]) delete connections[clientPeerId];
  addChatMessage("Um jogador saiu da sala.", "msg-system");
  updateAndBroadcastPlayerCount();
}

// --- MUNDO & BLOCOS ---
function applyBlockChange(chunkKey, blockKey, blockData) {
  if (!worldData[chunkKey]) worldData[chunkKey] = {};
  if (blockData === null) delete worldData[chunkKey][blockKey];
  else worldData[chunkKey][blockKey] = blockData;
}

function setBlockAt(tileX, tileY, blockData) {
  const chunkX = Math.floor(tileX / CHUNK_SIZE);
  const chunkY = Math.floor(tileY / CHUNK_SIZE);
  const chunkKey = `${chunkX}_${chunkY}`;
  const localTileX = ((tileX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const localTileY = ((tileY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const blockKey = `${localTileX}_${localTileY}`;

  if (isHost) {
    applyBlockChange(chunkKey, blockKey, blockData);
    broadcast({ type: 'BLOCK_UPDATE', chunkKey, blockKey, blockData });
  } else if (localPlayer.isAdmin && hostConn && hostConn.open) {
    hostConn.send({ type: 'BLOCK_UPDATE_REQUEST', chunkKey, blockKey, blockData, senderId: localPlayer.id });
  }
}

function getBlockAt(worldX, worldY) {
  const tileX = Math.floor(worldX / TILE_SIZE);
  const tileY = Math.floor(worldY / TILE_SIZE);
  const chunkX = Math.floor(tileX / CHUNK_SIZE);
  const chunkY = Math.floor(tileY / CHUNK_SIZE);
  const chunkKey = `${chunkX}_${chunkY}`;

  if (!worldData[chunkKey]) return null;
  const localTileX = ((tileX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const localTileY = ((tileY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const blockKey = `${localTileX}_${localTileY}`;

  return { block: worldData[chunkKey][blockKey] || null, chunkKey, blockKey };
}

// --- JOGADOR, ARMAS & LOOP ---
function respawnPlayer() {
  localPlayer.hp = 100;
  updateHpUI();

  let teamSpawnFound = null, nilSpawnFound = null;

  for (let chunkKey in worldData) {
    for (let blockKey in worldData[chunkKey]) {
      const b = worldData[chunkKey][blockKey];
      if (!b) continue;
      const [lx, ly] = blockKey.split('_').map(Number);
      const [cx, cy] = chunkKey.split('_').map(Number);
      const worldX = (cx * CHUNK_SIZE + lx) * TILE_SIZE + TILE_SIZE / 2;
      const worldY = (cy * CHUNK_SIZE + ly) * TILE_SIZE + TILE_SIZE / 2;

      if (b.type === 'team' && localPlayer.team && b.teamName === localPlayer.team) teamSpawnFound = { x: worldX, y: worldY };
      else if (b.type === 'nil_spawn') nilSpawnFound = { x: worldX, y: worldY };
    }
  }

  const spawn = teamSpawnFound || nilSpawnFound || globalDefaultSpawnPos || { x: 0, y: 0 };
  localPlayer.x = spawn.x;
  localPlayer.y = spawn.y;
}

function dieAndDropWeapon() {
  addChatMessage("[Sistema] Você morreu!", "msg-system");
  if (localPlayer.equippedTool === 'homing_weapon') {
    removeEquippedItem();
    setBlockAt(Math.floor(localPlayer.x / TILE_SIZE), Math.floor(localPlayer.y / TILE_SIZE), { type: 'homing_item', solid: false });
  }
  respawnPlayer();
}

function shootHomingMissile() {
  if (localPlayer.equippedTool !== 'homing_weapon') return;

  let closest = null, minDist = Infinity;
  for (let id in remotePlayers) {
    const p = remotePlayers[id];
    if (localPlayer.team && p.team && localPlayer.team === p.team) continue;
    const dist = Math.hypot(p.x - localPlayer.x, p.y - localPlayer.y);
    if (dist < minDist) { minDist = dist; closest = id; }
  }

  spawnProjectile(localPlayer.x, localPlayer.y, closest, localPlayer.id, localPlayer.team);
  const packet = { type: 'SHOOT_HOMING', senderId: localPlayer.id, senderTeam: localPlayer.team, x: localPlayer.x, y: localPlayer.y, targetId: closest };
  if (isHost) broadcast(packet);
  else if (hostConn && hostConn.open) hostConn.send(packet);
}

function spawnProjectile(x, y, targetId, senderId, senderTeam) {
  projectiles.push({ x, y, speed: 7, targetId, senderId, senderTeam, radius: 6, life: 300 });
}

function createExplosion(x, y) {
  for (let i = 0; i < 15; i++) {
    particles.push({ x, y, vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8, color: ['#ff2222', '#ffaa00', '#ffff00'][Math.floor(Math.random() * 3)], life: 20 });
  }
}

function checkCollision(nextX, nextY) {
  const half = localPlayer.size / 2;
  const points = [
    { x: nextX - half, y: nextY - half }, { x: nextX + half - 1, y: nextY - half },
    { x: nextX - half, y: nextY + half - 1 }, { x: nextX + half - 1, y: nextY + half - 1 }
  ];

  for (let p of points) {
    const cell = getBlockAt(p.x, p.y);
    const block = cell ? cell.block : null;
    if (block) {
      if (block.type === 'homing_item') {
        if (addItemToInventory('homing_weapon')) {
          addChatMessage("[Sistema] Você pegou uma Arma Guiada do chão!", "msg-system");
          applyBlockChange(cell.chunkKey, cell.blockKey, null);
          const packet = { type: 'REMOVE_WORLD_ITEM', chunkKey: cell.chunkKey, blockKey: cell.blockKey, senderId: localPlayer.id };
          if (isHost) broadcast(packet);
          else if (hostConn && hostConn.open) hostConn.send(packet);
        }
      }
      if (block.type === 'team' && block.touchEnabled !== false) {
        if (localPlayer.team !== block.teamName || localPlayer.color !== block.color) {
          localPlayer.team = block.teamName;
          localPlayer.color = block.color;
          document.getElementById('user-team').textContent = `${block.teamName}`;
          document.getElementById('user-team').style.color = block.color;
        }
      }
      if (block.solid) return true;
    }
  }
  return false;
}

let lastNetworkSend = 0;
function gameLoop(time) {
  const now = Date.now();

  if (joystickData.active) {
    const moveX = joystickData.x * localPlayer.speed;
    const moveY = joystickData.y * localPlayer.speed;
    if (!checkCollision(localPlayer.x + moveX, localPlayer.y)) localPlayer.x += moveX;
    if (!checkCollision(localPlayer.x, localPlayer.y + moveY)) localPlayer.y += moveY;
  }

  document.getElementById('user-pos').textContent = `X: ${Math.round(localPlayer.x)} | Y: ${Math.round(localPlayer.y)}`;

  if (time - lastNetworkSend > 33) {
    const posData = { type: 'POS', id: localPlayer.id, playerNumber: localPlayer.playerNumber, x: localPlayer.x, y: localPlayer.y, hp: localPlayer.hp, color: localPlayer.color, team: localPlayer.team, isAdmin: localPlayer.isAdmin, equippedTool: localPlayer.equippedTool };
    if (isHost) broadcast(posData);
    else if (hostConn && hostConn.open) hostConn.send(posData);
    lastNetworkSend = time;
  }

  const cameraX = localPlayer.x - canvas.width / 2;
  const cameraY = localPlayer.y - canvas.height / 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const startChunkX = Math.floor(cameraX / CHUNK_PIXELS);
  const endChunkX = Math.floor((cameraX + canvas.width) / CHUNK_PIXELS);
  const startChunkY = Math.floor(cameraY / CHUNK_PIXELS);
  const endChunkY = Math.floor((cameraY + canvas.height) / CHUNK_PIXELS);

  for (let cx = startChunkX; cx <= endChunkX; cx++) {
    for (let cy = startChunkY; cy <= endChunkY; cy++) {
      const chunkWorldX = cx * CHUNK_PIXELS - cameraX;
      const chunkWorldY = cy * CHUNK_PIXELS - cameraY;

      ctx.fillStyle = ((cx + cy) % 2 === 0) ? '#5b8731' : '#527c2c';
      ctx.fillRect(chunkWorldX, chunkWorldY, CHUNK_PIXELS, CHUNK_PIXELS);

      const chunkKey = `${cx}_${cy}`;
      if (worldData[chunkKey]) {
        for (let blockKey in worldData[chunkKey]) {
          const [lx, ly] = blockKey.split('_').map(Number);
          const bData = worldData[chunkKey][blockKey];
          const bx = chunkWorldX + lx * TILE_SIZE;
          const by = chunkWorldY + ly * TILE_SIZE;

          if (bData.type === 'stone') { ctx.fillStyle = bData.solid ? '#777' : '#999'; ctx.fillRect(bx, by, TILE_SIZE, TILE_SIZE); }
          else if (bData.type === 'wood') { ctx.fillStyle = bData.solid ? '#8B4513' : '#a65b24'; ctx.fillRect(bx, by, TILE_SIZE, TILE_SIZE); }
          else if (bData.type === 'dirt') { ctx.fillStyle = bData.solid ? '#5c4033' : '#7d5847'; ctx.fillRect(bx, by, TILE_SIZE, TILE_SIZE); }
          else if (bData.type === 'door') { ctx.fillStyle = '#D2691E'; ctx.fillRect(bx, by, TILE_SIZE, TILE_SIZE); }
          else if (bData.type === 'team') { ctx.fillStyle = bData.color || '#ff2222'; ctx.fillRect(bx, by, TILE_SIZE, TILE_SIZE); }
          else if (bData.type === 'nil_spawn') { ctx.fillStyle = '#888'; ctx.fillRect(bx, by, TILE_SIZE, TILE_SIZE); }
          else if (bData.type === 'homing_item') { ctx.fillText('🚀', bx + TILE_SIZE/2, by + TILE_SIZE/2); }
        }
      }
    }
  }

  // Desenhar projéteis e partículas
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.life--;
    let target = p.targetId === localPlayer.id ? localPlayer : remotePlayers[p.targetId];

    if (target) {
      const angle = Math.atan2(target.y - p.y, target.x - p.x);
      p.x += Math.cos(angle) * p.speed;
      p.y += Math.sin(angle) * p.speed;
    } else { p.x += p.speed; }

    if (target && Math.hypot(target.x - p.x, target.y - p.y) < 16) {
      createExplosion(p.x, p.y);
      if (p.targetId === localPlayer.id) {
        if (!p.senderTeam || !localPlayer.team || p.senderTeam !== localPlayer.team) {
          localPlayer.hp -= 25;
          updateHpUI();
          if (localPlayer.hp <= 0) dieAndDropWeapon();
        }
      }
      projectiles.splice(i, 1);
      continue;
    }
    if (p.life <= 0) { projectiles.splice(i, 1); continue; }

    ctx.fillStyle = '#ff3300';
    ctx.beginPath();
    ctx.arc(p.x - cameraX, p.y - cameraY, p.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    pt.x += pt.vx; pt.y += pt.vy; pt.life--;
    if (pt.life <= 0) { particles.splice(i, 1); continue; }
    ctx.fillStyle = pt.color;
    ctx.fillRect(pt.x - cameraX, pt.y - cameraY, 4, 4);
  }

  // Jogadores remotos
  for (let id in remotePlayers) {
    const p = remotePlayers[id];
    const sx = p.x - cameraX, sy = p.y - cameraY;
    ctx.fillStyle = p.color || '#ff0000';
    ctx.fillRect(sx - 12, sy - 12, 24, 24);
    if (p.bubble && now < p.bubble.expires) drawSpeechBubble(ctx, p.bubble.text, sx, sy);
  }

  // Jogador local
  const lx = canvas.width / 2, ly = canvas.height / 2;
  ctx.fillStyle = localPlayer.color;
  ctx.fillRect(lx - 12, ly - 12, 24, 24);
  if (localPlayer.bubble && now < localPlayer.bubble.expires) drawSpeechBubble(ctx, localPlayer.bubble.text, lx, ly);

  if (document.getElementById('game-container').style.display !== 'none') {
    requestAnimationFrame(gameLoop);
  }
  }
