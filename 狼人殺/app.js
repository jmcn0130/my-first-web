let peer = null;
let myId = '';
let myName = '';
let myRole = '';
let isAlive = true;
let isHost = false;
let hostConn = null;
let clients = {}; // Host 專用: peerId -> DataConnection

// 語音相關變數
let localStream = null;
let mediaCalls = {}; // peerId -> MediaConnection
let isMuted = false;

// 遊戲全域狀態 (由 Host 管理並傳送給所有 Client 同步)
let gameState = {
  phase: 'LOBBY', // LOBBY, NIGHT_WOLF, NIGHT_SEER, NIGHT_WITCH, DAY_HUNTER, DAY_DISCUSSION, DAY_VOTE
  players: [], // { id, name, role, isAlive, votes }
  potions: { save: true, poison: true },
  nightActions: { killTarget: null, saved: false, poisonTarget: null, checkTarget: null }
};

// --- 麥克風與語音控制 (WebRTC Audio) ---

async function initMic() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const statusEl = document.getElementById('mic-status');
    statusEl.innerText = '🎤 麥克風已就緒';
    statusEl.style.color = '#22c55e';
    return true;
  } catch (err) {
    alert('無法存取麥克風，請確認權限設定！');
    document.getElementById('mic-status').innerText = '❌ 麥克風開啟失敗';
    return false;
  }
}

function toggleMicMute() {
  if (!localStream) return alert('請先啟用麥克風！');
  isMuted = !isMuted;
  localStream.getAudioTracks()[0].enabled = !isMuted;
  const btn = document.getElementById('mic-toggle-btn');
  btn.innerText = isMuted ? '🎤 麥克風：靜音' : '🎙️ 麥克風：收音中';
  btn.className = isMuted ? 'btn btn-warning' : 'btn btn-success';
}

function callPeerAudio(peerId) {
  if (!localStream || mediaCalls[peerId]) return;
  const call = peer.call(peerId, localStream);
  handleIncomingCall(call);
}

function handleIncomingCall(call) {
  mediaCalls[call.peer] = call;
  call.answer(localStream);
  call.on('stream', (remoteStream) => {
    attachAudioStream(call.peer, remoteStream);
  });
  call.on('close', () => removeAudioStream(call.peer));
}

function attachAudioStream(peerId, stream) {
  let audio = document.getElementById(`audio-${peerId}`);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = `audio-${peerId}`;
    audio.autoplay = true;
    document.getElementById('audio-container').appendChild(audio);
  }
  audio.srcObject = stream;
}

function removeAudioStream(peerId) {
  const audio = document.getElementById(`audio-${peerId}`);
  if (audio) audio.remove();
  delete mediaCalls[peerId];
}

// --- 連線與網路架構 ---

function initPeer(callback) {
  peer = new Peer();
  peer.on('open', (id) => {
    myId = id;
    callback(id);
  });
  peer.on('error', (err) => alert('P2P 連線錯誤: ' + err.type));
  peer.on('call', (call) => handleIncomingCall(call));
}

function createRoom() {
  myName = document.getElementById('nickname').value.trim();
  if (!myName) return alert('請輸入暱稱！');

  initPeer((id) => {
    isHost = true;
    document.getElementById('display-room-id').innerText = id;
    setupHostServer();
    
    gameState.players.push({ id: myId, name: myName, role: '', isAlive: true, votes: 0 });
    showRoomUI();
    renderUI();
  });
}

function joinRoom() {
  myName = document.getElementById('nickname').value.trim();
  const targetRoomId = document.getElementById('join-room-id').value.trim();
  if (!myName || !targetRoomId) return alert('請輸入暱稱與房間號碼！');

  initPeer((id) => {
    isHost = false;
    hostConn = peer.connect(targetRoomId);

    hostConn.on('open', () => {
      hostConn.send({ type: 'JOIN', name: myName });
      document.getElementById('display-room-id').innerText = targetRoomId;
      showRoomUI();
    });

    hostConn.on('data', (data) => handleClientMessage(data));
    hostConn.on('close', () => alert('與房主斷開連線！'));
  });
}

function setupHostServer() {
  peer.on('connection', (conn) => {
    conn.on('data', (data) => handleHostMessage(conn, data));
    conn.on('close', () => {
      gameState.players = gameState.players.filter(p => p.id !== conn.peer);
      delete clients[conn.peer];
      broadcastState();
    });
  });
}

// --- 訊息同步機制 ---

function handleHostMessage(conn, data) {
  if (data.type === 'JOIN') {
    clients[conn.peer] = conn;
    gameState.players.push({ id: conn.peer, name: data.name, role: '', isAlive: true, votes: 0 });
    
    Object.keys(clients).forEach(peerId => {
      if (peerId !== conn.peer) callPeerAudio(peerId);
    });
    if (myId !== conn.peer) callPeerAudio(conn.peer);

    broadcastLog(`${data.name} 加入了遊戲。`);
    broadcastState();
  } 
  else if (data.type === 'ACTION') {
    processPlayerAction(conn.peer, data.action, data.payload);
  }
}

function handleClientMessage(data) {
  if (data.type === 'STATE_UPDATE') {
    gameState = data.state;
    const me = gameState.players.find(p => p.id === myId);
    if (me) {
      myRole = me.role;
      isAlive = me.isAlive;
    }
    renderUI();
  } else if (data.type === 'LOG') {
    log(data.message);
  }
}

function broadcastState() {
  if (!isHost) return;
  renderUI();
  Object.values(clients).forEach(conn => conn.send({ type: 'STATE_UPDATE', state: gameState }));
}

function broadcastLog(msg) {
  log(msg);
  if (!isHost) return;
  Object.values(clients).forEach(conn => conn.send({ type: 'LOG', message: msg }));
}

function sendPrivateLog(targetId, msg) {
  if (targetId === myId) {
    log(msg);
  } else if (clients[targetId]) {
    clients[targetId].send({ type: 'LOG', message: msg });
  }
}

// --- UI 與 介面渲染 ---

function showRoomUI() {
  document.getElementById('lobby-section').classList.add('hidden');
  document.getElementById('room-section').classList.remove('hidden');
  document.getElementById('log-section').classList.remove('hidden');
  if (isHost) document.getElementById('start-game-btn').classList.remove('hidden');
}

function renderUI() {
  document.getElementById('phase-display').innerText = getPhaseName(gameState.phase);
  document.getElementById('role-display').innerText = myRole ? `你的身份：${myRole}` : '等待發牌...';
  
  updatePlayerList();
  renderActionPanel();
}

function updatePlayerList() {
  const listEl = document.getElementById('player-list');
  listEl.innerHTML = '';

  gameState.players.forEach(p => {
    const card = document.createElement('div');
    card.className = `player-card ${p.isAlive ? '' : 'dead'}`;
    
    let statusBadge = p.isAlive 
      ? '<span class="badge" style="background:#22c55e;">存活</span>' 
      : '<span class="badge" style="background:#ef4444;">死亡</span>';
    
    let selfBadge = p.id === myId ? ' (你)' : '';
    let voteCount = (gameState.phase === 'DAY_VOTE' && p.votes > 0) ? `<br><small>得票數: ${p.votes}</small>` : '';

    card.innerHTML = `
      <strong>${p.name}${selfBadge}</strong><br>
      ${statusBadge} ${voteCount}
    `;
    listEl.appendChild(card);
  });
}

function renderActionPanel() {
  const actionEl = document.getElementById('action-content');
  actionEl.innerHTML = '';

  if (!isAlive && gameState.phase !== 'DAY_HUNTER') {
    actionEl.innerHTML = '<p style="color:#888;">你已死亡，無法進行任何操作（可繼續語音觀戰）。</p>';
    return;
  }

  if (gameState.phase === 'LOBBY') {
    actionEl.innerHTML = '<p>等待房主開始遊戲...</p>';
    return;
  }

  if (gameState.phase === 'NIGHT_WOLF' && myRole === '狼人') {
    actionEl.innerHTML = '<p>選擇今晚襲擊的目標：</p>';
    getAlivePlayers().forEach(p => {
      if (p.role !== '狼人') {
        const btn = createBtn(`襲擊 ${p.name}`, 'btn-danger', () => sendAction('WOLF_KILL', p.id));
        actionEl.appendChild(btn);
      }
    });
  }
  else if (gameState.phase === 'NIGHT_SEER' && myRole === '預言家') {
    actionEl.innerHTML = '<p>選擇今晚查驗的目標：</p>';
    getAlivePlayers().forEach(p => {
      if (p.id !== myId) {
        const btn = createBtn(`查驗 ${p.name}`, '', () => sendAction('SEER_CHECK', p.id));
        actionEl.appendChild(btn);
      }
    });
  }
  else if (gameState.phase === 'NIGHT_WITCH' && myRole === '女巫') {
    const killed = gameState.players.find(p => p.id === gameState.nightActions.killTarget);
    let infoText = killed ? `今晚被襲擊的是：<b style="color:var(--danger);">${killed.name}</b>` : '今晚無人受襲擊';
    
    let container = document.createElement('div');
    container.innerHTML = `<p>${infoText}</p>`;

    if (gameState.potions.save && killed) {
      const saveBtn = createBtn(`使用解藥救 ${killed.name}`, 'btn-success', () => sendAction('WITCH_ACTION', { type: 'SAVE' }));
      container.appendChild(saveBtn);
    }
    if (gameState.potions.poison) {
      getAlivePlayers().forEach(p => {
        if (p.id !== myId) {
          const poisonBtn = createBtn(`毒殺 ${p.name}`, 'btn-danger', () => sendAction('WITCH_ACTION', { type: 'POISON', targetId: p.id }));
          container.appendChild(poisonBtn);
        }
      });
    }
    const passBtn = createBtn('不使用任何藥水', '', () => sendAction('WITCH_ACTION', { type: 'PASS' }));
    container.appendChild(passBtn);

    actionEl.appendChild(container);
  }
  else if (gameState.phase === 'DAY_HUNTER' && myRole === '獵人') {
    actionEl.innerHTML = '<p style="color:var(--warning);">你已被帶走！請選擇一名玩家開槍帶走：</p>';
    getAlivePlayers().forEach(p => {
      if (p.id !== myId) {
        const btn = createBtn(`開槍帶走 ${p.name}`, 'btn-danger', () => sendAction('HUNTER_SHOOT', p.id));
        actionEl.appendChild(btn);
      }
    });
  }
  else if (gameState.phase === 'DAY_VOTE') {
    actionEl.innerHTML = '<p>請選擇你要投給哪位玩家放逐：</p>';
    getAlivePlayers().forEach(p => {
      const btn = createBtn(`投給 ${p.name}`, '', () => sendAction('VOTE', p.id));
      actionEl.appendChild(btn);
    });
  }
  else {
    actionEl.innerHTML = '<p>請等待其他玩家完成行動或進行語音討論...</p>';
  }
}

function createBtn(text, className, onClick) {
  const btn = document.createElement('button');
  btn.className = `btn ${className}`;
  btn.innerText = text;
  btn.onclick = onClick;
  return btn;
}

function sendAction(action, payload) {
  if (isHost) {
    processPlayerAction(myId, action, payload);
  } else {
    hostConn.send({ type: 'ACTION', action, payload });
  }
  document.getElementById('action-content').innerHTML = '<p>已完成選擇，等待階段推進...</p>';
}

// --- 核心遊戲邏輯 (Host 處理) ---

function hostStartGame() {
  if (gameState.players.length < 5) {
    return alert('五職業版本（狼人、預言家、女巫、獵人、平民）至少需要 5 人才能開始！');
  }

  let roles = ['狼人', '預言家', '女巫', '獵人'];
  while (roles.length < gameState.players.length) roles.push('平民');
  roles.sort(() => Math.random() - 0.5);

  gameState.players.forEach((p, idx) => {
    p.role = roles[idx];
    p.isAlive = true;
    p.votes = 0;
  });

  gameState.potions = { save: true, poison: true };
  broadcastLog('🎮 遊戲開始！身份已發放。天黑請閉眼...');
  startNightPhase();
}

function startNightPhase() {
  gameState.phase = 'NIGHT_WOLF';
  gameState.nightActions = { killTarget: null, saved: false, poisonTarget: null, checkTarget: null };
  broadcastLog('🌙 天黑請閉眼... 狼人請睜眼選擇襲擊目標。');
  broadcastState();
}

function processPlayerAction(playerId, action, payload) {
  if (!isHost) return;

  if (action === 'WOLF_KILL' && gameState.phase === 'NIGHT_WOLF') {
    gameState.nightActions.killTarget = payload;
    
    const seer = gameState.players.find(p => p.role === '預言家' && p.isAlive);
    if (seer) {
      gameState.phase = 'NIGHT_SEER';
      broadcastLog('🌙 狼人請閉眼，預言家請睜眼驗人...');
    } else {
      advanceToWitch();
    }
  }
  else if (action === 'SEER_CHECK' && gameState.phase === 'NIGHT_SEER') {
    const target = gameState.players.find(p => p.id === payload);
    sendPrivateLog(playerId, `[驗人結果] ${target.name} 的身份是：${target.role === '狼人' ? '🐺 狼人' : '😇 好人'}`);
    advanceToWitch();
  }
  else if (action === 'WITCH_ACTION' && gameState.phase === 'NIGHT_WITCH') {
    if (payload.type === 'SAVE' && gameState.potions.save) {
      gameState.nightActions.saved = true;
      gameState.potions.save = false;
    } else if (payload.type === 'POISON' && gameState.potions.poison) {
      gameState.nightActions.poisonTarget = payload.targetId;
      gameState.potions.poison = false;
    }
    resolveNightActions();
  }
  else if (action === 'HUNTER_SHOOT' && gameState.phase === 'DAY_HUNTER') {
    const target = gameState.players.find(p => p.id === payload);
    if (target) {
      target.isAlive = false;
      broadcastLog(`💥 獵人發動技能，開槍帶走了 ${target.name}！`);
    }
    
    if (!checkWinCondition()) {
      enterDayDiscussion();
    }
  }
  else if (action === 'VOTE' && gameState.phase === 'DAY_VOTE') {
    const target = gameState.players.find(p => p.id === payload);
    if (target) target.votes = (target.votes || 0) + 1;
    
    broadcastLog(`有人完成投票。`);
    
    const activeVotes = gameState.players.reduce((sum, p) => sum + (p.votes || 0), 0);
    if (activeVotes >= getAlivePlayers().length) {
      resolveDayVote();
    }
  }

  broadcastState();
}

function advanceToWitch() {
  const witch = gameState.players.find(p => p.role === '女巫' && p.isAlive);
  if (witch) {
    gameState.phase = 'NIGHT_WITCH';
    broadcastLog('🌙 預言家請閉眼，女巫請睜眼使用藥水...');
  } else {
    resolveNightActions();
  }
}

function resolveNightActions() {
  let deadTonight = [];

  if (gameState.nightActions.killTarget && !gameState.nightActions.saved) {
    deadTonight.push(gameState.nightActions.killTarget);
  }
  if (gameState.nightActions.poisonTarget) {
    deadTonight.push(gameState.nightActions.poisonTarget);
  }

  deadTonight.forEach(id => {
    const victim = gameState.players.find(p => p.id === id);
    if (victim) victim.isAlive = false;
  });

  let deathNames = deadTonight.map(id => gameState.players.find(p => p.id === id)?.name).join('、');
  broadcastLog(`☀️ 太陽升起，昨晚死亡的玩家是：${deathNames || '平安夜，無人死亡'}。`);

  if (checkWinCondition()) return;

  const deadHunter = deadTonight.map(id => gameState.players.find(p => p.id === id))
                                .find(p => p && p.role === '獵人');

  if (deadHunter) {
    gameState.phase = 'DAY_HUNTER';
    broadcastLog(`🔫 獵人 ${deadHunter.name} 死亡，發動開槍技能！`);
  } else {
    enterDayDiscussion();
  }
}

function enterDayDiscussion() {
  gameState.phase = 'DAY_DISCUSSION';
  broadcastLog('🗣️ 請大家開啟麥克風自由發言討論...');
  broadcastState();

  setTimeout(() => {
    gameState.phase = 'DAY_VOTE';
    gameState.players.forEach(p => p.votes = 0);
    broadcastLog('🗳️ 發言結束，請開始投票放逐一名玩家。');
    broadcastState();
  }, 15000);
}

function resolveDayVote() {
  let sorted = [...gameState.players].sort((a, b) => (b.votes || 0) - (a.votes || 0));
  let votedOut = sorted[0];

  if (votedOut && votedOut.votes > 0) {
    votedOut.isAlive = false;
    broadcastLog(`⚖️ 投票結果：${votedOut.name} 高票被放逐出場！`);

    if (votedOut.role === '獵人') {
      gameState.phase = 'DAY_HUNTER';
      broadcastLog(`🔫 獵人 ${votedOut.name} 被放逐，發動開槍技能！`);
      broadcastState();
      return;
    }
  } else {
    broadcastLog('⚖️ 投票平票或無人投票，今日平局無人被放逐。');
  }

  if (!checkWinCondition()) {
    startNightPhase();
  }
}

function checkWinCondition() {
  const wolves = gameState.players.filter(p => p.role === '狼人' && p.isAlive);
  const humans = gameState.players.filter(p => p.role !== '狼人' && p.isAlive);

  if (wolves.length === 0) {
    broadcastLog('🎉 遊戲結束！【好人陣營】淘汰所有狼人，獲得勝利！');
    gameState.phase = 'LOBBY';
    broadcastState();
    return true;
  } else if (wolves.length >= humans.length) {
    broadcastLog('🐺 遊戲結束！【狼人陣營】數量達到或超過好人，獲得勝利！');
    gameState.phase = 'LOBBY';
    broadcastState();
    return true;
  }
  return false;
}

// --- 輔助函式 ---

function getAlivePlayers() {
  return gameState.players.filter(p => p.isAlive);
}

function getPhaseName(phase) {
  const names = {
    'LOBBY': '等待房間中',
    'NIGHT_WOLF': '🌙 黑夜 - 狼人行動',
    'NIGHT_SEER': '🌙 黑夜 - 預言家驗人',
    'NIGHT_WITCH': '🌙 黑夜 - 女巫藥水',
    'DAY_HUNTER': '🔫 獵人開槍階段',
    'DAY_DISCUSSION': '☀️ 白天 - 語音討論中',
    'DAY_VOTE': '🗳️ 白天 - 投票放逐中'
  };
  return names[phase] || phase;
}

function log(msg) {
  const logEl = document.getElementById('game-log');
  const item = document.createElement('div');
  item.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(item);
  logEl.scrollTop = logEl.scrollHeight;}