import { dolaCookieMap, matchesGoogleIdentity } from './google-login-core.js';
import { accountHealth } from './account-observations.js';

/** A cached Google identity is provenance, not a fresh Google verification.
 * Require a live Dola session with the same Dola identity on the same proxy.
 * Unknown/network results must not cause another password submission.
 */
export async function verifySavedDolaSession(saved, email, account, { checkSession, fetchProfile, missingRequired, options }) {
  if (!saved) return { kind: 'relogin' };
  if (!options?.proxy || !matchesGoogleIdentity(saved.identity, email) || !saved.dolaId
      || (account?.sec_user_id && String(account.sec_user_id) !== String(saved.dolaId))) return { kind: 'blocked' };
  const cookies = dolaCookieMap(saved.cookies);
  if (missingRequired(cookies).length) return { kind: 'relogin' };
  try {
    const session = await checkSession(cookies, options);
    const profile = await fetchProfile(cookies, options);
    if (![session.pullStatus, session.launchStatus, profile.status].every(status => status === 200)) return { kind: 'blocked' };
    const health = accountHealth(session, profile);
    if (health.kind === 'invalid') return { kind: 'relogin' };
    if (health.kind !== 'valid' || String(profile.entityId || profile.id || '') !== String(saved.dolaId)) return { kind: 'blocked' };
    return { kind: 'reused', result: { kind: 'ready', identity: saved.identity, cookies, profile, sessionReused: true, loginStateSaved: true } };
  } catch { return { kind: 'blocked' }; }
}
