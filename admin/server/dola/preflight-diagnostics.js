const PHASES = new Set([
  'launch', 'context', 'navigate', 'bootstrap', 'entry', 'model', 'duration', 'verified',
]);
const SECONDS = new Set([10, 15, 20, 30]);
const MAX_COUNT = 9999;
const MAX_TIME_MS = 600000;

/** Rebuild the public/audit payload; never spread exception-owned objects. */
export function sanitizePreflightDiagnostic(input) {
  if (!input || input.version !== 1 || !PHASES.has(input.phase)) return null;
  const number = (value, max) => Number.isFinite(value) ? Math.min(max, Math.max(0, Math.trunc(value))) : 0;
  return { version: 1, phase: input.phase, seconds: SECONDS.has(input.seconds) ? input.seconds : null,
    elapsedMs: number(input.elapsedMs, MAX_TIME_MS), phaseElapsedMs: number(input.phaseElapsedMs, MAX_TIME_MS),
    reason: safeReason(input.reason),
    network: { failedRequests: number(input.network?.failedRequests, MAX_COUNT), httpErrors: number(input.network?.httpErrors, MAX_COUNT) },
    page: { errors: number(input.page?.errors, MAX_COUNT),
      lastErrorKind: ['type_error', 'reference_error', 'other'].includes(input.page?.lastErrorKind) ? input.page.lastErrorKind : '' } };
}

function elapsed(now, start) {
  return Math.min(MAX_TIME_MS, Math.max(0, Math.trunc(now - start)));
}

function safeReason(reason) {
  return typeof reason === 'string' && reason.length <= 80 && !/[^A-Z0-9_]/.test(reason)
    ? reason : '';
}

function errorKind(error) {
  try {
    const name = error?.name;
    if (name === 'TypeError') return 'type_error';
    if (name === 'ReferenceError') return 'reference_error';
  } catch {
    // An inaccessible name is still only an unclassified error.
  }
  return 'other';
}

/** Passive, in-memory diagnostics. Never retain event payloads or error text. */
export function createPreflightDiagnostics({ seconds, clock = Date.now } = {}) {
  const safeSeconds = SECONDS.has(seconds) ? seconds : null;
  const bindings = new Map();
  let disposed = false;
  let lastNow;

  function now() {
    if (!disposed) {
      try {
        const value = typeof clock === 'function' ? clock() : undefined;
        if (typeof value === 'number' && Number.isFinite(value)) {
          lastNow = lastNow === undefined ? value : Math.max(lastNow, value);
        }
      } catch {
        // Clock failures must not disrupt the preflight or expose their text.
      }
    }
    return lastNow ?? 0;
  }

  const startedAt = now();
  let phase = 'launch';
  let phaseStartedAt = startedAt;
  let failedRequests = 0;
  let httpErrors = 0;
  let errors = 0;
  let lastErrorKind = '';

  function mark(nextPhase) {
    if (disposed || !PHASES.has(nextPhase)) return;
    phase = nextPhase;
    phaseStartedAt = now();
  }

  function attach(page) {
    if (disposed || !page || bindings.has(page)) return;
    let on;
    let off;
    let removeListener;
    try {
      on = page.on;
      off = page.off;
      removeListener = page.removeListener;
    } catch {
      return;
    }
    // Only subscribe if the caller provides a way to remove our listeners.
    if (typeof on !== 'function'
        || (typeof off !== 'function' && typeof removeListener !== 'function')) return;

    const handlers = [
      ['requestfailed', () => {
        if (!disposed) failedRequests = Math.min(MAX_COUNT, failedRequests + 1);
      }],
      ['response', response => {
        if (disposed) return;
        try {
          const status = response?.status?.();
          if (Number.isInteger(status) && status >= 400 && status <= 599) {
            httpErrors = Math.min(MAX_COUNT, httpErrors + 1);
          }
        } catch {
          // Missing or broken response APIs provide no usable status.
        }
      }],
      ['pageerror', error => {
        if (disposed) return;
        errors = Math.min(MAX_COUNT, errors + 1);
        lastErrorKind = errorKind(error);
      }],
    ];
    const registered = [];
    const detach = () => {
      for (const [event, handler] of registered) {
        for (const remove of [off, removeListener]) {
          if (typeof remove !== 'function') continue;
          try {
            remove.call(page, event, handler);
            break;
          } catch {
            // Try the alternate removal API and continue cleaning other events.
          }
        }
      }
    };
    bindings.set(page, detach);
    for (const [event, handler] of handlers) {
      // Track before subscribing in case on() registers and then throws.
      registered.push([event, handler]);
      try {
        on.call(page, event, handler);
      } catch {
        // Retain cleanup for dispose() in case this immediate attempt fails.
        detach();
        break;
      }
    }
  }

  function snapshot(reason = '') {
    const current = now();
    return {
      version: 1,
      phase,
      elapsedMs: elapsed(current, startedAt),
      phaseElapsedMs: elapsed(current, phaseStartedAt),
      seconds: safeSeconds,
      reason: safeReason(reason),
      network: { failedRequests, httpErrors },
      page: { errors, lastErrorKind },
    };
  }

  function dispose() {
    if (disposed) return;
    now();
    disposed = true;
    for (const detach of bindings.values()) detach();
    bindings.clear();
  }

  return { mark, attach, snapshot, dispose };
}
