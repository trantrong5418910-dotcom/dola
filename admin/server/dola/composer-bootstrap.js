/** Observe the site's own action-bar configuration, without requests or mutations.
 * The visible video chip can precede this response; clicking that shell binds a
 * generic skill instead of the video engine. A successful config is a readiness
 * hint only: callers must still verify the actual model and duration controls.
 */
const states = new WeakMap();
const CONFIG_PATH = '/alice/slot/action_bar_v3/get_item_conf';

export function observeVideoComposerBootstrap(page) {
  if (states.has(page)) return;
  const state = { ready: false, closed: false, revision: 0, waiters: new Set() };
  states.set(page, state);
  const notify = value => { for (const finish of [...state.waiters]) finish(value); };
  const onNavigation = frame => {
    if (frame !== page.mainFrame()) return;
    state.revision++;
    state.ready = false;
  };
  const onResponse = async response => {
    const revision = state.revision;
    try {
      const url = new URL(response.url());
      if (url.protocol !== 'https:' || !(url.hostname === 'dola.com' || url.hostname.endsWith('.dola.com'))
          || url.pathname !== CONFIG_PATH || !response.ok()) return;
      const body = await response.json();
      const items = body?.data?.item_list;
      if (state.closed || revision !== state.revision || body?.code !== 0
          || !items || typeof items !== 'object' || Array.isArray(items) || !Object.keys(items).length) return;
      state.ready = true;
      notify(true);
    } catch { /* Partial/invalid responses never establish readiness. */ }
  };
  page.on('framenavigated', onNavigation);
  page.on('response', onResponse);
  page.once('close', () => {
    state.closed = true;
    notify(false);
    page.off('framenavigated', onNavigation);
    page.off('response', onResponse);
  });
}

/** Call observeVideoComposerBootstrap before navigation, so fast replies count. */
export async function waitForVideoComposerBootstrap(page, timeout) {
  const state = states.get(page);
  if (!state || state.closed) return false;
  if (state.ready) return true;
  return new Promise(resolve => {
    const finish = value => {
      clearTimeout(timer);
      state.waiters.delete(finish);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeout);
    state.waiters.add(finish);
  });
}
