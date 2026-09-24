import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { observeVideoComposerBootstrap, waitForVideoComposerBootstrap } from '../server/dola/composer-bootstrap.js';

const url = 'https://www.dola.com/alice/slot/action_bar_v3/get_item_conf';
const body = { code: 0, data: { item_list: { synthetic: {} } } };
function page() {
  const p = new EventEmitter();
  p.mainFrame = () => p;
  observeVideoComposerBootstrap(p);
  return p;
}
const response = (data = body, responseUrl = url, ok = true) => ({ url: () => responseUrl, ok: () => ok, json: async () => data });

test('only complete successful config establishes readiness; no generated requests', async () => {
  const p = page();
  observeVideoComposerBootstrap(p);
  assert.equal(p.listenerCount('response'), 1);
  const waiting = waitForVideoComposerBootstrap(p, 100);
  p.emit('response', response());
  assert.equal(await waiting, true);
  assert.equal(await waitForVideoComposerBootstrap(p, 10), true);
  p.emit('close');
  assert.equal(p.listenerCount('response'), 0);
});

for (const [name, res] of [
  ['failed HTTP', response(body, url, false)],
  ['business rejection', response({ ...body, code: 710022002 })],
  ['empty configuration', response({ code: 0, data: { item_list: {} } })],
  ['malformed items', response({ code: 0, data: { item_list: ['x'] } })],
  ['unrelated origin', response(body, 'https://dola.com.invalid/alice/slot/action_bar_v3/get_item_conf')],
  ['unrelated endpoint', response(body, 'https://www.dola.com/alice/profile/self')],
]) {
  test(`does not click through ${name}`, async () => {
    const p = page(); p.emit('response', res);
    assert.equal(await waitForVideoComposerBootstrap(p, 10), false);
    p.emit('close');
  });
}

test('navigation invalidates ready state and in-flight previous-page config', async () => {
  const p = page();
  let release;
  p.emit('response', { ...response(), json: () => new Promise(resolve => { release = resolve; }) });
  p.emit('framenavigated', p);
  release(body);
  assert.equal(await waitForVideoComposerBootstrap(p, 10), false);
  p.emit('response', response());
  assert.equal(await waitForVideoComposerBootstrap(p, 100), true);
  p.emit('framenavigated', {}); // subframe cannot erase the main frame's state
  assert.equal(await waitForVideoComposerBootstrap(p, 10), true);
  p.emit('framenavigated', p);
  assert.equal(await waitForVideoComposerBootstrap(p, 10), false);
  p.emit('close');
});

test('closing browser releases pending waits; missing observer fails closed', async () => {
  const p = page(), waiting = waitForVideoComposerBootstrap(p, 1000);
  p.emit('close');
  assert.equal(await waiting, false);
  assert.equal(await waitForVideoComposerBootstrap(p, 10), false);
  assert.equal(await waitForVideoComposerBootstrap({}, 10), false);
});
