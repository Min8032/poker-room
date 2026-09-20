/* =========================================================
 * net.js — P2P 网络层（基于 PeerJS 公共云，无需自建服务器）
 * 房主浏览器即"服务器"：洗牌、发牌、计票都在房主端进行
 * ========================================================= */
window.Net = (() => {
  // 房间 ID 前缀，避免与其他使用 PeerJS 公共云的应用冲突
  const PREFIX = 'poker3m-';

  // ICE 服务器：国内 STUN 优先；OpenRelay 免费公共 TURN 中继兜底
  // （移动网络/跨运营商等对称 NAT 场景打洞必失败，必须靠 TURN 中继）
  const ICE_SERVERS = [
    { urls: ['stun:stun.miwifi.com:3478'] },
    { urls: ['stun:stun.hitv.com:3478'] },
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
    { urls: ['stun:stun.relay.metered.ca:80'] },
    { urls: ['turn:global.relay.metered.ca:80'], username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: ['turn:global.relay.metered.ca:80?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: ['turn:global.relay.metered.ca:443'], username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: ['turns:global.relay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  let peer = null;
  let hostMode = false;
  const conns = new Map();   // 房主用：peerId -> DataConnection
  let hostConn = null;       // 加入者用：与房主的连接
  const handlers = {};       // 事件回调表

  function on(ev, fn) { handlers[ev] = fn; }
  function emit(ev, ...args) { if (handlers[ev]) handlers[ev](...args); }

  function newPeer(id) {
    const opts = { config: { iceServers: ICE_SERVERS }, debug: 0 };
    return id ? new Peer(id, opts) : new Peer(opts);
  }

  // 连接断线判定：closed/failed 立即判定；disconnected 给 6 秒宽限（可能是切网暂断）
  function watchDead(conn, onDead) {
    let dead = false, timer = null;
    const die = () => { if (!dead) { dead = true; clearTimeout(timer); onDead(); } };
    conn.on('close', die);
    conn.on('error', die);
    conn.on('iceStateChanged', st => {
      if (st === 'closed' || st === 'failed') die();
      else if (st === 'disconnected') {
        clearTimeout(timer);
        timer = setTimeout(die, 6000);
      } else if (st === 'connected' || st === 'completed') {
        clearTimeout(timer);
      }
    });
  }

  // 信令通道自愈：与 PeerJS 云的 WebSocket 断开后自动重连（重连成功前新房客进不来）
  function watchSignal() {
    let iv = null;
    peer.on('disconnected', () => {
      emit('sig', false);
      clearInterval(iv);
      let tries = 0;
      iv = setInterval(() => {
        if (!peer || peer.destroyed) { clearInterval(iv); return; }
        if (!peer.disconnected) { clearInterval(iv); emit('sig', true); return; }
        if (++tries > 20) { clearInterval(iv); return; }   // 约 1 分钟后放弃
        try { peer.reconnect(); } catch (e) {}
      }, 3000);
    });
  }

  /* ---------- 房主 ---------- */
  function createRoom(code) {
    return new Promise((resolve, reject) => {
      hostMode = true;
      let settled = false;
      peer = newPeer(PREFIX + code);

      peer.on('open', id => { settled = true; watchSignal(); resolve(id); });
      peer.on('error', err => {
        if (!settled) {
          settled = true;
          if (err.type === 'unavailable-id') reject(new Error('该房间密码已被占用，请换一个'));
          else reject(new Error('网络错误：' + err.type));
        }
      });

      peer.on('connection', conn => {
        conn.on('open', () => {
          conns.set(conn.peer, conn);
          conn.on('data', data => {
            if (!data || !data.t) return;
            if (data.t === 'join') emit('join', conn.peer, data.name, conn);
            else if (data.t === 'ready') emit('ready', conn.peer, data.ready);
            else if (data.t === 'reveal') emit('reveal', conn.peer, data.cards, data.on);
          });
          watchDead(conn, () => {
            conns.delete(conn.peer);
            emit('leave', conn.peer);
          });
        });
      });
    });
  }

  /* ---------- 加入者 ---------- */
  function joinRoom(code, name) {
    return new Promise((resolve, reject) => {
      hostMode = false;
      let settled = false;
      let retries = 0;
      let attemptTimer = null;
      peer = newPeer();

      const fail = msg => {
        if (settled) return;
        settled = true;
        clearTimeout(attemptTimer);
        reject(new Error(msg));
      };

      // 失败重试：最多 3 次，间隔 1.5 秒
      const retryOrFail = msg => {
        if (settled) return;
        clearTimeout(attemptTimer);
        if (retries < 3) { retries++; setTimeout(connectToHost, 1500); }
        else fail(msg);
      };

      const connectToHost = () => {
        if (settled) return;
        clearTimeout(attemptTimer);
        try { if (hostConn) hostConn.close(); } catch (e) {}
        hostConn = peer.connect(PREFIX + code, { reliable: true });

        // 单次尝试 8 秒超时：打洞失败/僵尸注册时不会无限卡在"加入中…"
        attemptTimer = setTimeout(
          () => retryOrFail('连接超时：双方网络受限（如移动网络+VPN），请切换网络后重试'), 8000);

        hostConn.on('open', () => {
          clearTimeout(attemptTimer);
          hostConn.send({ t: 'join', name });
          settled = true;
          resolve();
        });

        hostConn.on('data', data => {
          if (!data || !data.t) return;
          if (data.t === 'roster') emit('roster', data);
          else if (data.t === 'deal') emit('deal', data);
          else if (data.t === 'full') emit('full');
          else if (data.t === 'closed') emit('closed');
        });

        // 加入成功后断线才算"房间关闭"；重试中的失败由超时/error 处理
        watchDead(hostConn, () => { if (settled) emit('closed'); });
      };

      peer.on('error', err => {
        if (settled) return;
        // 房间注册可能有延迟/抖动：peer-unavailable 也走重试
        if (err.type === 'peer-unavailable') {
          retryOrFail('房间不存在，请检查房间密码（或让房主确认页面还开着）');
          return;
        }
        fail('网络错误：' + err.type);
      });

      peer.on('open', () => {
        watchSignal();
        connectToHost();
      });
    });
  }

  /* ---------- 收发 ---------- */
  function sendTo(id, msg) {           // 房主私发
    const c = conns.get(id);
    if (c && c.open) { try { c.send(msg); } catch (e) {} }
  }
  function broadcast(msg) {            // 房主群发
    conns.forEach(c => { if (c.open) { try { c.send(msg); } catch (e) {} } });
  }
  function send(msg) {                 // 加入者发给房主
    if (hostConn && hostConn.open) { try { hostConn.send(msg); } catch (e) {} }
  }
  function kick(id) {                  // 房主断开某人
    const c = conns.get(id);
    if (c) { try { c.close(); } catch (e) {} conns.delete(id); }
  }
  function destroy() {
    conns.forEach(c => { try { c.close(); } catch (e) {} });
    conns.clear();
    hostConn = null;
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
  }

  return {
    on, createRoom, joinRoom,
    sendTo, broadcast, send, kick, destroy,
    get myId() { return peer ? peer.id : null; },
    get isHost() { return hostMode; },
  };
})();
