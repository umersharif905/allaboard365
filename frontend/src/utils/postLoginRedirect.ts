/**
 * Resolve where to send the user after login (or when already logged in on /login).
 * - Query params: returnUrl, redirect, next, returnTo (first valid wins).
 * - Router location.state.from (set by ProtectedRoute / Navigate when sending users to /login).
 * Only same-origin relative paths (or absolute URLs matching this origin) are allowed.
 */

const MAX_LEN = 2048;
const QUERY_KEYS = ['returnUrl', 'redirect', 'next', 'returnTo'] as const;

function isLoginPath(path: string): boolean {
  return path === '/login' || path.startsWith('/login?') || path.startsWith('/login#') || path.startsWith('/login/');
}

/**
 * Returns pathname + search + hash, or null if the value is not a safe internal redirect.
 */
export function getSafeInternalReturnPath(raw: string): string | null {
  if (raw == null || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.length > MAX_LEN) return null;

  try {
    if (/^[a-zA-Z][a-zA-Z+.-]*:/.test(s)) {
      const u = new URL(s);
      if (typeof window !== 'undefined' && u.origin !== window.location.origin) return null;
      s = `${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    return null;
  }

  if (!s.startsWith('/') || s.startsWith('//')) return null;
  if (s.includes('\\')) return null;
  if (/^javascript:/i.test(s) || /[\u0000-\u001f]/.test(s)) return null;

  const base = s.split('#')[0];
  if (isLoginPath(base.split('?')[0] || '')) return null;

  return s.slice(0, MAX_LEN);
}

export function pickReturnPathFromSearchParams(searchParams: URLSearchParams): string | null {
  for (const key of QUERY_KEYS) {
    const v = searchParams.get(key);
    if (!v) continue;
    let decoded = v;
    try {
      decoded = decodeURIComponent(v);
    } catch {
      /* use raw */
    }
    const path = getSafeInternalReturnPath(decoded);
    if (path) return path;
  }
  return null;
}

/** React Router: Navigate state is `{ from: Location }` (see ProtectedRoute). */
export function pickReturnPathFromRouterState(stateFrom: unknown): string | null {
  if (!stateFrom || typeof stateFrom !== 'object') return null;
  const o = stateFrom as Record<string, unknown>;
  const loc =
    o.from && typeof o.from === 'object' && o.from !== null && 'pathname' in (o.from as object)
      ? (o.from as { pathname?: string; search?: string; hash?: string })
      : (stateFrom as { pathname?: string; search?: string; hash?: string });

  if (!loc.pathname || typeof loc.pathname !== 'string') return null;
  const combined = `${loc.pathname}${loc.search ?? ''}${loc.hash ?? ''}`;
  return getSafeInternalReturnPath(combined);
}

export function resolvePostLoginPath(options: {
  searchParams: URLSearchParams;
  routerState: unknown;
  roleDefault: string;
}): string {
  const fromQuery = pickReturnPathFromSearchParams(options.searchParams);
  if (fromQuery) return fromQuery;

  const fromState = pickReturnPathFromRouterState(options.routerState);
  if (fromState) return fromState;

  return options.roleDefault;
}
