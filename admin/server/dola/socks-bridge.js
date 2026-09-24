/**
 * 本地 SOCKS5 中转桥：帮**浏览器**绕开"socks5 不支持带认证"这个硬限制。
 *
 * ## 为什么需要它
 *
 * IPWeb 的网关实测只认 SOCKS5（HTTP 代理模式带凭据会被静默关闭），
 * 而 Chromium/Playwright 明确不支持**带用户名密码的 SOCKS5**：
 *
 *     browserType.launchPersistentContext:
 *       Browser does not support socks5 proxy authentication
 *
 * 我们自己的 HTTP 调用没这问题（undici 支持 socks5 + 认证），卡住的只有浏览器。
 *
 * ## 做法
 *
 * 在本机起一个**不需要认证**的 HTTP 代理，它把流量转给上游带认证的 SOCKS5：
 *
 *     浏览器 ──HTTP CONNECT──▶ 本桥(127.0.0.1:随机端口) ──SOCKS5+认证──▶ IPWeb ──▶ 目标站
 *
 * 浏览器只看到"一个本地无认证代理"，认证在桥里完成。
 * 一个桥对应一条上游代理（即一个账号），用完就关。
 */
import net from 'node:net';

/** 解析 socks5://user:pass@host:port */
function parseSocksUrl(url) {
  const u = new URL(url);
  if (!/^socks5?h?:$/.test(u.protocol)) throw new Error(`不是 socks5 代理：${u.protocol}`);
  return {
    host: u.hostname,
    port: Number(u.port || 1080),
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  };
}

/** 与上游 SOCKS5 建连 + 认证 + 请求连到 targetHost:targetPort */
function socksConnect(up, targetHost, targetPort, signal) {
  return new Promise((resolve, reject) => {
    const s = net.connect(up.port, up.host);
    let step = 0;
    let buf = Buffer.alloc(0);

    const fail = (m) => { try { s.destroy(); } catch { /* ignore */ } reject(new Error(m)); };
    const abort = () => fail('代理桥已关闭');
    signal?.addEventListener('abort', abort, { once: true });
    s.once('close', () => signal?.removeEventListener('abort', abort));
    if (signal?.aborted) { abort(); return; }
    s.setTimeout(20000, () => fail('连上游 SOCKS5 超时'));
    s.on('error', (e) => fail(`连上游 SOCKS5 失败：${e.code || e.message}`));

    s.on('connect', () => {
      // ① 问候：声明支持「无认证」和「用户名密码」两种
      s.write(up.username ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
    });

    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (step === 0) {
        if (buf.length < 2) return;
        const method = buf[1];
        buf = buf.subarray(2);
        if (method === 0xff) return fail('上游不接受任何认证方式');
        if (method === 2) {
          if (!up.username) return fail('上游要求认证但没提供用户名密码');
          const u = Buffer.from(up.username);
          const p = Buffer.from(up.password);
          s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          step = 1;
          return;
        }
        if (method === 0) { step = 2; sendConnect(); return; }
        return fail(`上游返回了不支持的认证方式：${method}`);
      }
      if (step === 1) {
        if (buf.length < 2) return;
        const ok = buf[1] === 0;
        buf = buf.subarray(2);
        if (!ok) return fail('上游 SOCKS5 认证失败（用户名或密码不对）');
        step = 2;
        sendConnect();
        return;
      }
      if (step === 2) {
        if (buf.length < 10) return;
        const rep = buf[1];
        if (rep !== 0) {
          const REASONS = { 1: '一般性失败', 2: '规则不允许', 3: '网络不可达', 4: '主机不可达', 5: '连接被拒', 6: 'TTL 超时', 7: '不支持的命令', 8: '不支持的地址类型' };
          return fail(`上游 SOCKS5 连接目标失败：${REASONS[rep] || 'rep=' + rep}`);
        }
        // ⚠️ 必须把整个应答头切掉再交出去。SOCKS5 的 CONNECT 应答
        //    是「rep + rsv + atyp + 地址 + 端口」，长度随 atyp 变（IPv4=10、域名=7+len、IPv6=22）。
        //    漏切或按固定 10 切都会把应答字节当成隧道数据喂给客户端，
        //    TLS 那边会报 `wrong version number`（收到的是明文）。
        const atyp = buf[3];
        let replyLen;
        if (atyp === 1) replyLen = 10;                              // IPv4
        else if (atyp === 4) replyLen = 22;                         // IPv6
        else if (atyp === 3) replyLen = buf.length >= 5 ? 7 + buf[4] : -1; // 域名
        else return fail(`上游返回了不支持的地址类型：${atyp}`);
        if (replyLen < 0 || buf.length < replyLen) return;

        const leftover = buf.subarray(replyLen);
        s.removeAllListeners('data');
        s.removeAllListeners('error');
        s.setTimeout(0);
        resolve({ socket: s, leftover });
      }
    });

    function sendConnect() {
      // 用域名（type=03）让上游去解析 —— 避免本机 DNS 被劫持影响
      const h = Buffer.from(targetHost);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort, 0);
      s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, portBuf]));
    }
  });
}

/**
 * 起一个本地无认证 HTTP 代理，上游走带认证的 SOCKS5。
 * @param {string} upstreamSocksUrl 形如 socks5://user:pass@host:port
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>, stats:{tunnels:number}}>}
 */
export function startSocksBridge(upstreamSocksUrl) {
  const up = parseSocksUrl(upstreamSocksUrl);
  const stats = { tunnels: 0, errors: [] };
  const sockets = new Set();
  const controller = new AbortController();
  let closePromise;

  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      sockets.add(client);
      client.once('close', () => sockets.delete(client));
      let buf = Buffer.alloc(0);
      let settled = false;

      const cleanup = () => { try { client.destroy(); } catch { /* ignore */ } };

      const onData = async (chunk) => {
        if (settled) return;
        buf = Buffer.concat([buf, chunk]);
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd < 0) { if (buf.length > 65536) { settled = true; cleanup(); } return; }
        settled = true;
        client.removeListener('data', onData);

        const head = buf.subarray(0, headEnd).toString('latin1');
        const rest = buf.subarray(headEnd + 4);
        const firstLine = head.split('\r\n')[0] || '';
        const m = /^([A-Z]+)\s+(\S+)\s+HTTP\/1\.[01]$/.exec(firstLine);
        if (!m) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }

        const [, method, targetRaw] = m;
        let targetHost; let targetPort;
        if (method === 'CONNECT') {
          // CONNECT host:port
          const i = targetRaw.lastIndexOf(':');
          targetHost = targetRaw.slice(0, i).replace(/^\[|\]$/g, '');
          targetPort = Number(targetRaw.slice(i + 1)) || 443;
        } else {
          // 普通 HTTP 请求：GET http://host/path HTTP/1.1
          try {
            const u = new URL(targetRaw);
            targetHost = u.hostname;
            targetPort = Number(u.port || 80);
          } catch { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
        }

        try {
          const { socket: upstream, leftover } = await socksConnect(up, targetHost, targetPort, controller.signal);
          if (controller.signal.aborted || client.destroyed) { upstream.destroy(); cleanup(); return; }
          sockets.add(upstream);
          upstream.once('close', () => sockets.delete(upstream));
          stats.tunnels++;

          if (method === 'CONNECT') {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (rest.length) upstream.write(rest);
          } else {
            // 把绝对 URL 改写成相对路径再转发
            const rewritten = head.replace(/^([A-Z]+)\s+\S+/, (_, verb) => `${verb} ${new URL(targetRaw).pathname}${new URL(targetRaw).search}`);
            upstream.write(Buffer.concat([Buffer.from(rewritten + '\r\n\r\n', 'latin1'), rest]));
          }
          if (leftover?.length) client.write(leftover);

          client.pipe(upstream);
          upstream.pipe(client);
          const bye = () => { try { upstream.destroy(); } catch { /* ignore */ } cleanup(); };
          client.on('error', bye); client.on('close', bye);
          upstream.on('error', bye); upstream.on('close', bye);
        } catch (e) {
          stats.errors.push(e.message);
          client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
      };

      client.on('data', onData);
      client.on('error', cleanup);
      client.setTimeout(120000, cleanup);
    });

    server.on('error', reject);
    // 只监听本机回环，不对外暴露
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        stats,
        // server.close() alone waits for active/idle tunnels indefinitely.
        // Close pending handshakes and established sockets so probe deadlines hold.
        close: () => closePromise ||= new Promise((r) => {
          controller.abort();
          for (const socket of sockets) socket.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}
