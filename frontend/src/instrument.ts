import React from 'react';
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { getApiUrl } from './config/api';
import { getPostHogSessionReplayUrl } from './config/posthog';

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

// Sentry is off in local dev: Turk Telekom blocks *.ingest.sentry.io at both
// the DNS and TLS-SNI layers, so envelopes can't reach Sentry from a dev
// machine on that ISP even with the backend tunnel. Override by setting
// VITE_SENTRY_ENABLE_IN_DEV=true (e.g. when on VPN).
const enabled =
    !!dsn &&
    (import.meta.env.MODE !== 'development' ||
        import.meta.env.VITE_SENTRY_ENABLE_IN_DEV === 'true');

if (enabled) {
  Sentry.init({
    dsn,
    // Route envelopes through our own backend so ad-blockers don't drop them
    // (manifested as ERR_CONNECTION_RESET on *.ingest.sentry.io). Must be an
    // absolute URL to the API origin: in production the SPA (allaboard365.com)
    // and API (api.allaboard365.com) are different hosts, so a relative
    // '/api/sentry-tunnel' would hit the SPA host, which has no such route.
    tunnel: `${getApiUrl()}/api/sentry-tunnel`,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION as string | undefined,

    integrations: [
      Sentry.reactRouterV7BrowserTracingIntegration({
        useEffect: React.useEffect,
        useLocation,
        useNavigationType,
        createRoutesFromChildren,
        matchRoutes,
      }),
      Sentry.replayIntegration({
        maskAllText: false,
        maskAllInputs: true,
        blockAllMedia: false,
      }),
    ],

    tracesSampleRate: import.meta.env.MODE === 'production' ? 0.2 : 1.0,

    tracePropagationTargets: [
      'localhost',
      /^\/api\//,
      /^https:\/\/api\.allaboard365\.com/,
      /^https:\/\/allaboard365-backend-ctehcsb5cbedauc0\.centralus-01\.azurewebsites\.net/,
    ],

    replaysSessionSampleRate: import.meta.env.MODE === 'production' ? 0.1 : 0,
    replaysOnErrorSampleRate: 1.0,

    sendDefaultPii: false,

    beforeSend(event) {
      const replayUrl = getPostHogSessionReplayUrl();
      if (!replayUrl) return event;

      return {
        ...event,
        contexts: {
          ...event.contexts,
          posthog: {
            ...(typeof event.contexts?.posthog === 'object' && event.contexts.posthog !== null
              ? event.contexts.posthog
              : {}),
            session_replay_url: replayUrl,
          },
        },
        tags: {
          ...event.tags,
          posthog_replay: 'yes',
        },
      };
    },
  });
} else if (import.meta.env.MODE !== 'test') {
  console.warn(
    dsn
      ? '[Sentry] disabled in dev (set VITE_SENTRY_ENABLE_IN_DEV=true to override)'
      : '[Sentry] VITE_SENTRY_DSN not set — Sentry disabled',
  );
}
