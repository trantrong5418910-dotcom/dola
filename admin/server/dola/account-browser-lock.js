/** Process-local lock for the persistent Chromium profile owned by one Dola account. */
const held = new Set();

export function tryAcquireAccountBrowserLock(accountId) {
  const key = String(accountId ?? 'anonymous');
  if (held.has(key)) return null;
  held.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(key);
  };
}

export function isAccountBrowserLocked(accountId) {
  return held.has(String(accountId ?? 'anonymous'));
}
