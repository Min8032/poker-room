/* =========================================================
 * game.js — 扑克房间游戏逻辑
 * 规则：一副 54 张牌，每人 3 张；默认盖牌，可翻看自己的牌；
 *       所有人都点"重新开始"才进入下一局。
 * 房主端为权威状态（洗牌/发牌/计票），其他人只收状态同步。
 * ========================================================= */
(() => {
  'use strict';

  /* ---------- 常量 ---------- */
  const CARD_DIR = 'assets/cards/';
  const CARD_BACK = '2B';                 // 盖牌卡背（按需求用 2B）
  const MAX_PLAYERS = 10;
  const EMOJIS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐰', '🐵', '🐨', '🐷', '🐮'];
  const CODE_RE = /^[A-Za-z0-9]{4,12}$/;  // 房间密码：4~12 位数字或字母

  /* ---------- 页面状态 ---------- */
  const S = {
    code: '',          // 房间密码
    isHost: false,
    round: 0,          // 当前局数，0 = 未开始
    players: [],       // [{id,name,emoji,ready,hasCards}]（以房主广播为准）
    myCards: [],       // 我的手牌，如 ['AS','KD','3C']
    faceUp: [false, false, false], // 我本地翻牌状态（不会发给任何人）
    revealed: false,   // 明牌状态：true = 我的牌对全房间可见
    cardCount: 3,      // 每人发牌数（房主设置，随房间状态同步）
    withJokers: true,  // 是否含大小王（房主设置，随房间状态同步）
  };

  /* ---------- 房主权威数据（仅房主使用） ---------- */
  const H = {
    players: new Map(),  // id -> {id,name,emoji,ready,hasCards}
    order: [],           // 加入顺序
    remaining: [],       // 牌堆剩余（用于中途加入者补发）
    cardCount: 3,        // 每人发牌数（建房选项）
    withJokers: true,    // 是否含大小王（建房选项）
  };

  /* ---------- DOM ---------- */
  const $ = id => document.getElementById(id);
  const el = {
    lobby: $('lobby'), table: $('table'),
    nickname: $('nickname'), roomCode: $('roomCode'),
    btnCreate: $('btnCreate'), btnJoin: $('btnJoin'), lobbyMsg: $('lobbyMsg'),
    dealSeg: $('dealSeg'), optJokers: $('optJokers'),
    roomInfo: $('roomInfo'), roundInfo: $('roundInfo'), btnLeave: $('btnLeave'),
    opponents: $('opponents'), statusBar: $('statusBar'),
    meInfo: $('meInfo'), myCards: $('myCards'),
    btnFlip: $('btnFlip'), btnReveal: $('btnReveal'), btnRestart: $('btnRestart'),
  };

  /* ---------- 工具 ---------- */
  const cardSrc = code => CARD_DIR + code + '.png';

  function buildDeck(withJokers) {
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
    const suits = ['S', 'H', 'D', 'C'];
    const d = [];
    for (const r of ranks) for (const s of suits) d.push(r + s);
    if (withJokers) d.push('1J', '2J');   // 大小王（可选）
    return d;                             // 54 张（不含王则 52 张）
  }

  function shuffle(a) {           // Fisher-Yates + 加密随机数
    const rnd = new Uint32Array(a.length);
    crypto.getRandomValues(rnd);
    for (let i = a.length - 1; i > 0; i--) {
      const j = rnd[i] % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const me = () => S.players.find(p => p.id === Net.myId);
  const myReady = () => { const m = me(); return m ? m.ready : false; };

  /* =========================================================
   * 房主逻辑
   * ========================================================= */
  function hostSetup(code, name, opts) {
    S.isHost = true; S.code = code; S.round = 0;
    H.players.clear(); H.order = []; H.remaining = [];
    H.cardCount = (opts && opts.cardCount) || 3;
    H.withJokers = !opts || opts.withJokers !== false;
    S.cardCount = H.cardCount; S.withJokers = H.withJokers;
    hostAddPlayer(Net.myId, name);

    Net.on('join', (id, pname) => {
      if (H.players.size >= MAX_PLAYERS) {
        Net.sendTo(id, { t: 'full' });
        setTimeout(() => Net.kick(id), 300);
        return;
      }
      hostAddPlayer(id, pname);
      // 中途加入：若已开局且牌够，立即补发
      if (S.round > 0 && H.remaining.length >= H.cardCount) {
        const cards = H.remaining.splice(0, H.cardCount);
        const p = H.players.get(id);
        p.hasCards = true;
        Net.sendTo(id, { t: 'deal', cards, round: S.round });
      }
      hostBroadcastRoster();
    });

    Net.on('ready', (id, ready) => {
      const p = H.players.get(id);
      if (!p) return;
      p.ready = !!ready;
      hostBroadcastRoster();
      hostCheckAllReady();
    });

    Net.on('reveal', (id, cards, on) => {
      const p = H.players.get(id);
      if (!p) return;
      p.revealed = (on && Array.isArray(cards)) ? cards.slice(0, H.cardCount) : null;
      hostBroadcastRoster();
    });

    Net.on('leave', id => {
      if (!H.players.has(id)) return;
      H.players.delete(id);
      H.order = H.order.filter(x => x !== id);
      hostBroadcastRoster();
      hostCheckAllReady();   // 离开者可能正挡着重开
    });
  }

  function hostAddPlayer(id, name) {
    const emoji = EMOJIS[H.order.length % EMOJIS.length];
    const clean = (name || '').trim().slice(0, 8) || ('玩家' + (H.order.length + 1));
    H.players.set(id, { id, name: clean, emoji, ready: false, hasCards: false, revealed: null });
    H.order.push(id);
  }

  function hostRosterData() {
    return {
      t: 'roster',
      round: S.round,
      host: Net.myId,
      cardCount: H.cardCount,        // 建房选项同步给所有人（渲染背面牌数用）
      jokers: H.withJokers,
      players: H.order.map(id => {
        const p = H.players.get(id);
        return { id: p.id, name: p.name, emoji: p.emoji, ready: p.ready, hasCards: p.hasCards, revealed: p.revealed || null };
      }),
    };
  }

  function hostBroadcastRoster() {
    const data = hostRosterData();
    Net.broadcast(data);
    applyRoster(data);       // 房主自己本地应用
  }

  function hostCheckAllReady() {
    if (S.round === 0) return;                 // 第一局由房主手动开始
    if (H.players.size === 0) return;
    for (const p of H.players.values()) if (!p.ready) return;
    hostStartRound();                          // 全员准备 → 下一局
  }

  function hostStartRound() {
    S.round++;
    const deck = shuffle(buildDeck(H.withJokers));
    for (const id of H.order) {
      const cards = deck.splice(0, H.cardCount);
      const p = H.players.get(id);
      p.hasCards = true;
      p.ready = false;
      p.revealed = null;                       // 新局默认不明牌
      if (id === Net.myId) {                   // 房主自己的牌
        S.myCards = cards;
        S.faceUp = cards.map(() => false);
        S.revealed = false;
      } else {
        Net.sendTo(id, { t: 'deal', cards, round: S.round });
      }
    }
    H.remaining = deck;
    hostBroadcastRoster();
  }

  /* =========================================================
   * 加入者逻辑
   * ========================================================= */
  function clientSetup(code) {
    S.isHost = false; S.code = code; S.round = 0;

    Net.on('roster', applyRoster);
    Net.on('deal', data => {
      S.myCards = data.cards;
      S.faceUp = data.cards.map(() => false);  // 新牌默认盖着
      S.revealed = false;                      // 新局默认不明牌
      render();
    });
    Net.on('full', () => fatalBack('房间已满（最多 ' + MAX_PLAYERS + ' 人）'));
    Net.on('closed', () => fatalBack('房主已解散房间'));
  }

  /* =========================================================
   * 状态应用与渲染
   * ========================================================= */
  function applyRoster(data) {
    S.round = data.round;
    S.players = data.players;
    S.hostId = data.host || '';
    if (data.cardCount) S.cardCount = data.cardCount;
    if (typeof data.jokers === 'boolean') S.withJokers = data.jokers;
    render();
  }

  function render() {
    el.roomInfo.textContent = '房间 ' + S.code + '（点我复制）';
    el.roundInfo.textContent = (S.round > 0 ? '第 ' + S.round + ' 局' : '未开始') +
      ' · ' + S.cardCount + '张/人' + (S.withJokers ? ' · 含大小王' : ' · 无大小王');

    renderOpponents();
    renderMe();
    renderButtons();
    renderStatus();
  }

  function renderOpponents() {
    const others = S.players.filter(p => p.id !== Net.myId);
    el.opponents.innerHTML = '';
    if (others.length === 0) {
      const tip = document.createElement('div');
      tip.className = 'empty-tip';
      tip.textContent = '还没有其他玩家，把房间密码告诉小伙伴吧';
      el.opponents.appendChild(tip);
      return;
    }
    for (const p of others) {
      const div = document.createElement('div');
      div.className = 'player' + (p.hasCards ? '' : ' empty');

      const hostTag = (p.id === S.hostId) ? '（房主）' : '';
      const mingTag = p.revealed ? '<span class="ming-tag">明牌</span>' : '';
      div.innerHTML =
        '<div class="avatar">' + p.emoji + '</div>' +
        '<div class="p-info">' +
          '<div class="p-name">' + escapeHtml(p.name) + hostTag + mingTag + '</div>' +
          '<div class="p-ready ' + (p.ready ? 'yes' : '') + '">' +
            (p.ready ? '✓ 已准备' : '进行中') +
          '</div>' +
        '</div>' +
        '<div class="p-cards">' +
          (p.hasCards
            ? (p.revealed
                ? p.revealed.map(c => '<img class="reveal" src="' + cardSrc(c) + '" alt="' + c + '">').join('')
                : Array.from({ length: S.cardCount }, () => '<img src="' + cardSrc(CARD_BACK) + '">').join(''))
            : '') +
        '</div>';
      el.opponents.appendChild(div);
    }
  }

  function renderMe() {
    const m = me();
    const name = m ? m.name : '我';
    const emoji = m ? m.emoji : '👤';
    const ready = m ? m.ready : false;
    el.meInfo.innerHTML =
      '<span class="avatar">' + emoji + '</span>' +
      '<span>' + escapeHtml(name) + (S.isHost ? '（房主）' : '') + '（我）</span>' +
      (S.revealed ? '<span class="ming-tag">明牌中</span>' : '') +
      '<span class="p-ready ' + (ready ? 'yes' : '') + '">' +
        (ready ? '✓ 已准备' : '') +
      '</span>';
    el.myCards.classList.toggle('revealed', S.revealed);

    el.myCards.innerHTML = '';
    if (S.myCards.length === 0) {
      const d = document.createElement('div');
      d.className = 'no-card';
      d.textContent = S.round === 0 ? '等待发牌…' : '等待下一局…';
      el.myCards.appendChild(d);
      return;
    }
    S.myCards.forEach((code, i) => {
      const img = document.createElement('img');
      img.src = cardSrc(S.faceUp[i] ? code : CARD_BACK);
      img.alt = code;
      img.addEventListener('click', () => {   // 点单张牌单独翻/盖
        S.faceUp[i] = !S.faceUp[i];
        render();
      });
      el.myCards.appendChild(img);
    });
  }

  function renderButtons() {
    const hasCards = S.myCards.length > 0;
    const anyUp = S.faceUp.some(x => x);
    el.btnFlip.disabled = !hasCards;
    el.btnFlip.textContent = anyUp ? '盖牌' : '翻牌';
    el.btnReveal.disabled = !hasCards;
    el.btnReveal.textContent = S.revealed ? '取消明牌' : '明牌';

    if (S.round === 0) {
      if (S.isHost) {
        el.btnRestart.disabled = false;
        el.btnRestart.textContent = '开始发牌';
      } else {
        el.btnRestart.disabled = true;
        el.btnRestart.textContent = '等待房主发牌';
      }
    } else {
      el.btnRestart.disabled = false;
      el.btnRestart.textContent = myReady() ? '取消准备' : '进入下一局';
    }
  }

  function renderStatus() {
    if (S.round === 0) {
      el.statusBar.textContent = S.isHost
        ? '你是房主，人齐后点"开始发牌"'
        : '等待房主发牌…';
      return;
    }
    const total = S.players.length;
    const ready = S.players.filter(p => p.ready).length;
    el.statusBar.textContent = '准备下一局 ' + ready + '/' + total +
      (myReady() ? '，等待其他小伙伴…' : '，点"进入下一局"加入');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* =========================================================
   * 屏幕切换与异常退出
   * ========================================================= */
  function showScreen(name) {
    el.lobby.classList.toggle('hidden', name !== 'lobby');
    el.table.classList.toggle('hidden', name !== 'table');
  }

  function fatalBack(msg) {
    alert(msg);
    backToLobby();
  }

  function backToLobby() {
    Net.destroy();
    S.code = ''; S.round = 0; S.players = [];
    S.myCards = []; S.faceUp = [false, false, false]; S.revealed = false;
    S.cardCount = 3; S.withJokers = true;
    el.btnCreate.disabled = false;
    el.btnJoin.disabled = false;
    showScreen('lobby');
  }

  /* =========================================================
   * 事件绑定
   * ========================================================= */
  function readInputs() {
    const name = el.nickname.value.trim();
    const code = el.roomCode.value.trim();
    if (!name) { el.lobbyMsg.textContent = '先起个昵称吧'; return null; }
    if (!CODE_RE.test(code)) { el.lobbyMsg.textContent = '房间密码需为 4~12 位数字或字母'; return null; }
    localStorage.setItem('poker_name', name);
    localStorage.setItem('poker_code', code);
    return { name, code };
  }

  /* ---------- 大厅：建房选项 ---------- */
  let lobbyDealCount = 3;   // 当前选中的发牌数（1~3）

  function syncDealSeg() {
    el.dealSeg.querySelectorAll('.seg-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.n, 10) === lobbyDealCount);
    });
  }

  el.dealSeg.addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    lobbyDealCount = parseInt(btn.dataset.n, 10) || 3;
    syncDealSeg();
    localStorage.setItem('poker_dealcount', String(lobbyDealCount));
  });

  el.optJokers.addEventListener('change', () => {
    localStorage.setItem('poker_jokers', el.optJokers.checked ? '1' : '0');
  });

  el.btnCreate.addEventListener('click', async () => {
    const v = readInputs(); if (!v) return;
    el.btnCreate.disabled = true; el.btnJoin.disabled = true;
    el.lobbyMsg.textContent = '创建中…';
    try {
      await Net.createRoom(v.code);
      hostSetup(v.code, v.name, { cardCount: lobbyDealCount, withJokers: el.optJokers.checked });
      showScreen('table');
      render();
    } catch (e) {
      el.lobbyMsg.textContent = e.message || '创建失败，请重试';
      el.btnCreate.disabled = false; el.btnJoin.disabled = false;
    }
  });

  el.btnJoin.addEventListener('click', async () => {
    const v = readInputs(); if (!v) return;
    el.btnCreate.disabled = true; el.btnJoin.disabled = true;
    el.lobbyMsg.textContent = '加入中…';
    try {
      await Net.joinRoom(v.code, v.name);
      clientSetup(v.code);
      showScreen('table');
      render();
    } catch (e) {
      el.lobbyMsg.textContent = e.message || '加入失败，请重试';
      el.btnCreate.disabled = false; el.btnJoin.disabled = false;
    }
  });

  el.btnFlip.addEventListener('click', () => {
    if (S.myCards.length === 0) return;
    const anyUp = S.faceUp.some(x => x);
    S.faceUp = S.myCards.map(() => !anyUp);   // 有亮着的就全盖，否则全翻
    render();
  });

  el.btnReveal.addEventListener('click', () => {
    if (S.myCards.length === 0) return;
    S.revealed = !S.revealed;
    const cards = S.revealed ? S.myCards.slice() : null;
    if (S.isHost) {                            // 房主直接改自己的明牌状态
      const p = H.players.get(Net.myId);
      if (p) p.revealed = cards;
      hostBroadcastRoster();
    } else {
      Net.send({ t: 'reveal', cards, on: S.revealed });   // 加入者报给房主转发
    }
    render();
  });

  el.btnRestart.addEventListener('click', () => {
    if (S.round === 0) {
      if (S.isHost) hostStartRound();          // 房主手动开始第一局
      return;
    }
    const next = !myReady();
    if (S.isHost) {                            // 房主直接改自己的票
      const p = H.players.get(Net.myId);
      if (p) p.ready = next;
      hostBroadcastRoster();
      hostCheckAllReady();
    } else {
      Net.send({ t: 'ready', ready: next });   // 加入者报给房主
    }
  });

  el.btnLeave.addEventListener('click', () => {
    if (!confirm('确定离开房间吗？')) return;
    if (S.isHost) Net.broadcast({ t: 'closed' });
    backToLobby();
  });

  el.roomInfo.addEventListener('click', () => {
    const copy = () => {
      el.statusBar.textContent = '房间密码 ' + S.code + ' 已复制，发给小伙伴吧';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(S.code).then(copy).catch(copy);
    } else copy();
  });

  // 在房间内误刷新/关闭时给个提示
  window.addEventListener('beforeunload', e => {
    if (S.code) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- 初始化 ---------- */
  el.nickname.value = localStorage.getItem('poker_name') || '';
  el.roomCode.value = localStorage.getItem('poker_code') || '';
  lobbyDealCount = parseInt(localStorage.getItem('poker_dealcount') || '3', 10);
  if (lobbyDealCount < 1 || lobbyDealCount > 3) lobbyDealCount = 3;
  syncDealSeg();
  el.optJokers.checked = localStorage.getItem('poker_jokers') !== '0';
  showScreen('lobby');
})();
