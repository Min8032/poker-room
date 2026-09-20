/* =========================================================
 * net.js — 房间网络层（MQTT 公共代理中转，无需自建服务器、无需打洞）
 *
 * 为什么不用 P2P：PeerJS 依赖境外信令服务器 + STUN/TURN 打洞，
 * 国内移动网络（对称 NAT）下极不稳定。MQTT 模式下双方都只是
 * 普通的"向外连接"国内可达的代理服务器，任何网络都能通。
 *
 * 架构：房主浏览器仍是"游戏服务器"（洗牌/发牌/计票在房主端），
 * EMQX 公共 broker 只负责按房间主题转发消息。
 *
 * 主题设计（前缀 poker3m/v1/ 避免与他人冲突）：
 *   poker3m/v1/{密码}/h  —— 房主收件箱（加入者发布，房主订阅）
 *   poker3m/v1/{密码}/r  —— 房间广播（房主发布，加入者订阅）
 * 私信：广播里带 to 字段，只有 id 匹配的加入者处理。
 * 在线状态：利用 MQTT 遗嘱（LWT）——异常断线时 broker 自动代发
 *   房主遗嘱 {t:'closed'} → 加入者得知房间关闭
 *   加入者遗嘱 {t:'bye'}  → 房主得知某人离开
 * ========================================================= */
window.Net = (() => {
  const BROKER = 'wss://broker.emqx.io:8084/mqtt';   // EMQX 免费公共代理（国内可达）
  const TOPIC_PREFIX = 'poker3m/v1/';

  let client = null;
  let hostMode = false;
  let myId = null;
  let roomCode = null;
  const handlers = {};

  function on(ev, fn) { handlers[ev] = fn; }
  function emit(ev, ...args) { if (handlers[ev]) handlers[ev](...args); }

  const tIn = code => TOPIC_PREFIX + code + '/h';    // 房主收件箱
  const tOut = code => TOPIC_PREFIX + code + '/r';   // 房间广播

  function rid() { return 'c' + Math.random().toString(36).slice(2, 10); }

  function connect(willTopic, willObj) {
    const opts = {
      clientId: 'poker3m-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36),
      clean: true,
      reconnectPeriod: 2000,      // 掉线自动重连
      connectTimeout: 10000,
      keepalive: 25,              // 异常断线约 40 秒内被 broker 发现（触发遗嘱）
      resubscribe: true,          // 重连后自动恢复订阅
    };
    if (willTopic) {
      opts.will = { topic: willTopic, payload: JSON.stringify(willObj), qos: 1, retain: false };
    }
    return mqtt.connect(BROKER, opts);
  }

  function pub(topic, obj) {
    if (client && client.connected) {
      try { client.publish(topic, JSON.stringify(obj), { qos: 1 }); } catch (e) {}
    }
  }

  // 连接状态自愈提示：断开 → sig(false)，恢复 → sig(true)
  function watchSig() {
    client.on('close', () => emit('sig', false));
    client.on('offline', () => emit('sig', false));
    client.on('connect', () => emit('sig', true));
  }

  function parse(payload) {
    try { return JSON.parse(payload.toString()); } catch (e) { return null; }
  }

  /* ---------- 房主 ---------- */
  function createRoom(code) {
    return new Promise((resolve, reject) => {
      hostMode = true;
      myId = rid();
      roomCode = code;
      let settled = false;

      // 异常断开时 broker 代发房间关闭通知
      client = connect(tOut(code), { t: 'closed' });
      watchSig();

      const fail = msg => {
        if (settled) return;
        settled = true;
        try { client.end(true); } catch (e) {}
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail('连接服务器超时，请重试'), 12000);

      // 占用检测：先 ping 一下该密码是否已有房主（公共 broker 没有房间注册概念）
      let pongHeard = false;

      client.on('connect', () => {
        client.subscribe([tIn(code), tOut(code)], { qos: 1 }, err => {
          if (err) { clearTimeout(timer); fail('订阅失败，请重试'); return; }
          // 订阅成功后 ping 一次，等 2.5 秒看有没有现存房主应答
          pub(tIn(code), { t: 'ping', from: myId });
          setTimeout(() => {
            if (settled) return;
            clearTimeout(timer);
            settled = true;
            if (pongHeard) {
              try { client.end(true); } catch (e) {}
              reject(new Error('该房间密码已被占用，请换一个'));
            } else {
              resolve(myId);
            }
          }, 2500);
        });
      });

      client.on('error', err => { if (!settled) { clearTimeout(timer); fail('网络错误：' + err.message); } });

      client.on('message', (topic, payload) => {
        const data = parse(payload);
        if (!data || !data.t) return;
        // 房主只处理收件箱里的加入者消息 + 占用检测的 ping
        if (topic === tIn(code)) {
          if (data.t === 'ping') {
            // 已是房主（settled 后）才应答；创建探测期不应答自己
            if (settled && data.from !== myId) pub(tOut(code), { t: 'pong' });
          }
          else if (data.t === 'join') emit('join', data.from, data.name);
          else if (data.t === 'ready') emit('ready', data.from, data.ready);
          else if (data.t === 'reveal') emit('reveal', data.from, data.cards, data.on);
          else if (data.t === 'bye') emit('leave', data.from);
        } else if (topic === tOut(code)) {
          if (data.t === 'pong') pongHeard = true;
          // 其余广播（roster/deal/closed 等）是房主自己发的，忽略
        }
      });
    });
  }

  /* ---------- 加入者 ---------- */
  function joinRoom(code, name) {
    return new Promise((resolve, reject) => {
      hostMode = false;
      myId = rid();
      roomCode = code;
      let settled = false;
      let retries = 0;
      let attemptTimer = null;

      // 异常断开时 broker 代发 bye，房主端显示离开
      client = connect(tIn(code), { t: 'bye', from: myId });
      watchSig();

      const fail = msg => {
        if (settled) return;
        settled = true;
        clearTimeout(attemptTimer);
        try { client.end(true); } catch (e) {}
        reject(new Error(msg));
      };

      // 发 join 后等房主 roster 回应；无回应 = 房间不存在，重试 3 次
      const sendJoin = () => {
        if (settled) return;
        clearTimeout(attemptTimer);
        pub(tIn(code), { t: 'join', name, from: myId });
        attemptTimer = setTimeout(() => {
          if (retries < 2) { retries++; sendJoin(); }
          else fail('房间不存在，请检查房间密码（或让房主确认页面还开着）');
        }, 6000);
      };

      const timer = setTimeout(() => fail('连接服务器超时，请检查网络后重试'), 12000);

      client.on('connect', () => {
        client.subscribe(tOut(code), { qos: 1 }, err => {
          if (err) { clearTimeout(timer); fail('订阅失败，请重试'); return; }
          clearTimeout(timer);
          sendJoin();
        });
      });

      client.on('error', err => { if (!settled) { clearTimeout(timer); fail('网络错误：' + err.message); } });

      client.on('message', (topic, payload) => {
        const data = parse(payload);
        if (!data || !data.t) return;
        if (data.to && data.to !== myId) return;   // 私信不是给我的

        if (data.t === 'roster') {
          if (!settled) { settled = true; clearTimeout(attemptTimer); resolve(); }
          emit('roster', data);
        }
        else if (data.t === 'deal') emit('deal', data);
        else if (data.t === 'full') {
          if (!settled) fail('房间已满，请稍后再试');
          else emit('full');
        }
        else if (data.t === 'closed') emit('closed');
      });
    });
  }

  /* ---------- 收发 ---------- */
  function sendTo(id, msg) {           // 房主私发（带 to 字段的广播）
    if (roomCode) pub(tOut(roomCode), Object.assign({}, msg, { to: id }));
  }
  function broadcast(msg) {            // 房主群发
    if (roomCode) pub(tOut(roomCode), msg);
  }
  function send(msg) {                 // 加入者发给房主
    if (roomCode) pub(tIn(roomCode), Object.assign({}, msg, { from: myId }));
  }
  function kick(id) {                  // 房主请某人离开（对方收到 closed 后自动退回大厅）
    sendTo(id, { t: 'closed' });
  }
  function destroy() {
    if (client) {
      // 优雅断开不会触发遗嘱，手动补发离开/关闭通知
      try {
        if (hostMode && roomCode) pub(tOut(roomCode), { t: 'closed' });
        else if (roomCode) pub(tIn(roomCode), { t: 'bye', from: myId });
      } catch (e) {}
      const c = client;
      client = null;
      setTimeout(() => { try { c.end(); } catch (e) {} }, 400);   // 等通知发出再断开
    }
    roomCode = null;
  }

  return {
    on, createRoom, joinRoom,
    sendTo, broadcast, send, kick, destroy,
    get myId() { return myId; },
    get isHost() { return hostMode; },
  };
})();
