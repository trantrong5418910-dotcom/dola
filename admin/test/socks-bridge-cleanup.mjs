import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { startSocksBridge } from '../server/dola/socks-bridge.js';

for (const phase of ['idle-client', 'handshake', 'tunnel']) {
  test(`bridge close is bounded and idempotent with ${phase}`, { timeout: 2500 }, async t => {
    const upstreamSockets = new Set();
    const upstream = net.createServer(socket => {
      upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket));
      if (phase !== 'tunnel') return;
      let greeted = false;
      socket.on('data', () => {
        if (!greeted) { greeted = true; socket.write(Buffer.from([5, 0])); }
        else socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
      });
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const bridge = await startSocksBridge(`socks5://127.0.0.1:${upstream.address().port}`);
    const client = net.connect(bridge.port, '127.0.0.1');
    t.after(async () => {
      client.destroy(); await bridge.close();
      for (const socket of upstreamSockets) socket.destroy();
      await new Promise(resolve => upstream.close(resolve));
    });
    await once(client, 'connect');
    if (phase !== 'idle-client') {
      const connected = once(upstream, 'connection');
      const response = phase === 'tunnel' ? once(client, 'data') : null;
      client.write('CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n');
      await connected;
      if (response) assert.match(String((await response)[0]), /200 Connection Established/);
    }
    const start = Date.now();
    await Promise.all([bridge.close(), bridge.close()]);
    assert.ok(Date.now() - start < 1000);
  });
}
