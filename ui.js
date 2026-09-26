// --- CONTROLES DE INTERFACE & BOTOES ---
document.getElementById('btn-create').addEventListener('click', () => {
  const id = document.getElementById('room-id-input').value.trim();
  if (id) initHost(id);
});

document.getElementById('btn-join').addEventListener('click', () => {
  const id = document.getElementById('room-id-input').value.trim();
  if (id) initClient(id);
});

document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
});

document.getElementById('btn-toggle-chat').addEventListener('click', () => {
  const chatBox = document.getElementById('chat-box');
  chatBox.style.display = chatBox.style.display === 'flex' ? 'none' : 'flex';
});

document.getElementById('btn-toggle-admin').addEventListener('click', () => {
  const admin = document.getElementById('admin-toolbar');
  admin.style.display = admin.style.display === 'flex' ? 'none' : 'flex';
});

document.getElementById('btn-toggle-collision').addEventListener('click', (e) => {
  placeWithCollision = !placeWithCollision;
  e.target.textContent = `Colisão Blocos: ${placeWithCollision ? 'LIG' : 'DESL'}`;
});

document.getElementById('btn-toggle-touch-team').addEventListener('click', (e) => {
  teamTouchEnabled = !teamTouchEnabled;
  e.target.textContent = `Trocar ao Relar: ${teamTouchEnabled ? 'LIG' : 'DESL'}`;
});

document.getElementById('btn-set-global-spawn').addEventListener('click', () => {
  globalDefaultSpawnPos = { x: localPlayer.x, y: localPlayer.y };
  addChatMessage("[Sistema] Spawn Padrão definido aqui!", "msg-system");
  const packet = { type: 'SET_GLOBAL_SPAWN', spawn: globalDefaultSpawnPos };
  if (isHost) broadcast(packet);
  else if (hostConn && hostConn.open) hostConn.send(packet);
});

document.querySelectorAll('.admin-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.admin-btn').forEach(b => b.classList.remove('selected'));
    e.currentTarget.classList.add('selected');
    selectedTool = e.currentTarget.getAttribute('data-type');
    document.getElementById('team-config-box').style.display = (selectedTool === 'team') ? 'flex' : 'none';
  });
});

// --- HOTBAR & INVENTÁRIO ---
document.querySelectorAll('.hotbar-slot').forEach(slot => {
  slot.addEventListener('click', () => {
    const idx = parseInt(slot.getAttribute('data-index'));
    activeSlotIndex = (activeSlotIndex === idx) ? -1 : idx;
    updateHotbarUI();
  });
});

function updateHotbarUI() {
  document.querySelectorAll('.hotbar-slot').forEach((slot, idx) => {
    slot.querySelector('.slot-icon').textContent = playerInventory[idx] === 'homing_weapon' ? '🚀' : '';
    slot.classList.toggle('active', idx === activeSlotIndex && playerInventory[idx] !== null);
  });
  localPlayer.equippedTool = (activeSlotIndex !== -1) ? playerInventory[activeSlotIndex] : null;
}

function addItemToInventory(itemType) {
  const emptyIndex = playerInventory.indexOf(null);
  if (emptyIndex !== -1) {
    playerInventory[emptyIndex] = itemType;
    if (activeSlotIndex === -1) activeSlotIndex = emptyIndex;
    updateHotbarUI();
    return true;
  }
  return false;
}

function removeEquippedItem() {
  if (activeSlotIndex !== -1 && playerInventory[activeSlotIndex] !== null) {
    const item = playerInventory[activeSlotIndex];
    playerInventory[activeSlotIndex] = null;
    activeSlotIndex = -1;
    updateHotbarUI();
    return item;
  }
  return null;
}

function updateHpUI() {
  const userHpEl = document.getElementById('user-hp');
  userHpEl.textContent = `${localPlayer.hp} HP`;
  userHpEl.style.color = localPlayer.hp > 50 ? '#55ff55' : (localPlayer.hp > 20 ? '#ffff55' : '#ff5555');
}

function updateAdminUIState() {
  const btnToggleAdmin = document.getElementById('btn-toggle-admin');
  const userRoleEl = document.getElementById('user-role');
  if (localPlayer.isAdmin || isHost) {
    btnToggleAdmin.style.display = "block";
    userRoleEl.textContent = isHost ? "ADMIN (Host)" : "ADMIN";
    userRoleEl.style.color = "#ffcc00";
  } else {
    btnToggleAdmin.style.display = "none";
    userRoleEl.textContent = "Sem Rank";
    userRoleEl.style.color = "#aaa";
  }
}

function updateAndBroadcastPlayerCount() {
  const total = 1 + Object.keys(remotePlayers).length;
  document.getElementById('player-count').textContent = total;
  if (isHost) broadcast({ type: 'PLAYER_COUNT', count: total });
}

// --- CHAT & COMANDOS ---
document.getElementById('btn-chat-send').addEventListener('click', sendChatMessage);
document.getElementById('chat-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChatMessage(); });

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  if (text.startsWith(':cmds')) {
    addChatMessage("📜 Comandos: :cmds, :teams, :ranks, :tools, /dar <num>", "msg-system");
  } else {
    addChatMessage("Você: " + text, "msg-self");
    triggerSpeechBubble(localPlayer.id, text);
    const data = { type: 'CHAT', senderId: localPlayer.id, playerNumber: localPlayer.playerNumber, msg: text };
    if (isHost) broadcast(data);
    else if (hostConn && hostConn.open) hostConn.send(data);
  }
  input.value = "";
}

function addChatMessage(msgText, className) {
  const chatMessages = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = "msg " + className;
  div.textContent = msgText;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function triggerSpeechBubble(playerId, text) {
  const now = Date.now();
  if (playerId === localPlayer.id) localPlayer.bubble = { text, expires: now + 4000 };
  else if (remotePlayers[playerId]) remotePlayers[playerId].bubble = { text, expires: now + 4000 };
}

function drawSpeechBubble(ctx, text, screenX, screenY) {
  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(screenX - 20, screenY - 40, 40, 16);
  ctx.fillStyle = '#000';
  ctx.fillText(text, screenX, screenY - 30);
}

// --- JOYSTICK TOUCH ---
const base = document.getElementById('joystick-base');
const thumb = document.getElementById('joystick-thumb');
const joystickData = { x: 0, y: 0, active: false };
let activePointerId = null;

base.addEventListener('pointerdown', (e) => {
  activePointerId = e.pointerId;
  base.setPointerCapture(activePointerId);
  joystickData.active = true;
  updateJoystick(e);
});

base.addEventListener('pointermove', (e) => {
  if (joystickData.active && e.pointerId === activePointerId) updateJoystick(e);
});

const stopJoystick = (e) => {
  if (e.pointerId === activePointerId) {
    activePointerId = null;
    joystickData.active = false;
    joystickData.x = 0; joystickData.y = 0;
    thumb.style.transform = `translate(-50%, -50%)`;
  }
};
base.addEventListener('pointerup', stopJoystick);

function updateJoystick(e) {
  const rect = base.getBoundingClientRect();
  let dx = e.clientX - (rect.left + rect.width / 2);
  let dy = e.clientY - (rect.top + rect.height / 2);
  const dist = Math.hypot(dx, dy);
  if (dist > 60) { dx = (dx / dist) * 60; dy = (dy / dist) * 60; }
  thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  joystickData.x = dx / 60;
  joystickData.y = dy / 60;
}

function resetToLobby() {
  if (peer) peer.destroy();
  location.reload();
}

function startGame() {
  document.getElementById('lobby-screen').style.display = 'none';
  document.getElementById('game-container').style.display = 'block';
  resizeCanvas();
  respawnPlayer();
  requestAnimationFrame(gameLoop);
}
