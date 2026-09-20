/** Only an exact archive endpoint may receive the server-side gateway secret. */
export function parseMediaUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    return url;
  } catch { return null; }
}

export function isGatewayArchiveUrl(value, base) {
  const url = parseMediaUrl(value);
  const gateway = parseMediaUrl(base);
  if (!url || !gateway || url.origin !== gateway.origin || gateway.search) return false;
  const prefix = gateway.pathname.replace(/\/+$/, '') + '/api/gateway/gen/';
  return url.pathname.startsWith(prefix)
    && /^[A-Za-z0-9_-]+\/file$/.test(url.pathname.slice(prefix.length));
}
