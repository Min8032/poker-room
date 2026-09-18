/* =========================================================
 * net.js — P2P 网络层（基于 PeerJS 公共云，无需自建服务器）
 * 房主浏览器即"服务器"：洗牌、发牌、计票都在房主端进行
 * ========================================================= */
window.Net = (() => {
  // 房间 ID 前缀，避免与其他使用 PeerJS 公共云的应用冲突
  const PREFIX = 'poker3m-';

  // ICE 服务器：国内可用的 STUN 优先，谷歌 STUN 兜底
  const ICE_SERVERS = [
    { urls: ['stun:stun.miwifi.com:3478'] },
    { urls: ['stun:stun.hitv.com:3478'] },
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
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

  /* ---------- 房主 ---------- */
  function createRoom(code) {
    return new Promise((resolve, reject) => {
      hostMode = true;
      let settled = false;
      peer = newPeer(PREFIX + code);

      peer.on('open', id => { settled = true; resolve(id); });
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
      peer = newPeer();

      peer.on('error', err => {
        if (!settled) {
          settled = true;
          if (err.type === 'peer-unavailable') reject(new Error('房间不存在，请检查房间密码'));
          else reject(new Error('网络错误：' + err.type));
        }
      });

      peer.on('open', () => {
        hostConn = peer.connect(PREFIX + code, { reliable: true });

        hostConn.on('open', () => {
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

        watchDead(hostConn, () => emit('closed'));
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
