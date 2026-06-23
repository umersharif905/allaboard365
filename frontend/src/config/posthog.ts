import posthog from 'posthog-js';

const apiKey = import.meta.env.VITE_POSTHOG_API_KEY as string | undefined;
const apiHost = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com';

let initialized = false;

export const initPostHog = (): void => {
  if (initialized) return;
  if (!apiKey) {
    console.warn('[PostHog] VITE_POSTHOG_API_KEY not set — analytics disabled');
    return;
  }

  posthog.init(apiKey, {
    api_host: apiHost,
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '[data-ph-mask]',
    },
    persistence: 'localStorage+cookie',
    loaded: (ph) => {
      if (import.meta.env.DEV) ph.debug(false);
    },
  });

  initialized = true;
};

export const identifyPostHogUser = (user: {
  userId: string;
  email?: string;
  tenantId?: string;
  userType?: string;
}): void => {
  if (!initialized) return;
  posthog.identify(user.userId, {
    email: user.email,
    tenantId: user.tenantId,
    userType: user.userType,
  });
  if (user.tenantId) {
    posthog.group('tenant', user.tenantId);
  }
};

export const resetPostHog = (): void => {
  if (!initialized) return;
  posthog.reset();
};

/** True when PostHog finished init (session replay may still be unavailable). */
export const isPostHogReady = (): boolean => initialized;

/**
 * Best-effort PostHog session replay URL for debugging (bug reports, Sentry).
 * Returns undefined when PostHog is off, recording isn't active, or the SDK throws.
 */
export const getPostHogSessionReplayUrl = (options?: {
  withTimestamp?: boolean;
  timestampLookBack?: number;
}): string | undefined => {
  if (!initialized) return undefined;

  try {
    const url = posthog.get_session_replay_url({
      withTimestamp: options?.withTimestamp ?? true,
      timestampLookBack: options?.timestampLookBack ?? 30,
    });
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return url;
    }
  } catch {
    // Recording disabled, SDK not ready, or no active replay session.
  }

  return undefined;
};

export { posthog };
