import './instrument' // Sentry init — MUST be first import
import { QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import ReactDOM from 'react-dom/client'
import * as Sentry from '@sentry/react'
import App from './App'
import './index.css'
import { queryClient } from './lib/queryClient'
import { tokenManager } from './services/tokenManager'
import './styles/theme.css'
import './utils/errorTracking'; // Initialize error tracking
import './utils/persistentErrorLogger'; // Initialize persistent error logging
import './utils/persistentConsoleLogger'; // Initialize persistent console logging
import { loadRuntimeConfig } from './config/api'
import { loadRuntimeBrandConfig } from './config/branding'
import { logApiConfigVerification } from './utils/verifyApiConfig'
import { BrandingProvider } from './contexts/BrandingContext'
import { initPostHog } from './config/posthog'

tokenManager.initialize(); // Initialize token manager
initPostHog(); // Initialize PostHog analytics + session replay

// Load runtime configs from /config.json before rendering app
// This allows Azure environment variables to set the API URL and brand at runtime
Promise.all([
  loadRuntimeConfig(),
  loadRuntimeBrandConfig()
]).then(() => {
  // Verify API configuration on startup (after runtime config loads)
  logApiConfigVerification();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Sentry.ErrorBoundary fallback={<div role="alert" style={{ padding: 24 }}>Something went wrong. Our team has been notified.</div>}>
        <BrandingProvider>
          <QueryClientProvider client={queryClient}>
            <App />
            <div id="portal-root"></div>
          </QueryClientProvider>
        </BrandingProvider>
      </Sentry.ErrorBoundary>
    </React.StrictMode>,
  )
}).catch((error) => {
  console.error('[Main] Failed to load runtime config:', error);
  // Still render app with build-time config
  logApiConfigVerification();
  
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Sentry.ErrorBoundary fallback={<div role="alert" style={{ padding: 24 }}>Something went wrong. Our team has been notified.</div>}>
        <BrandingProvider>
          <QueryClientProvider client={queryClient}>
            <App />
            <div id="portal-root"></div>
          </QueryClientProvider>
        </BrandingProvider>
      </Sentry.ErrorBoundary>
    </React.StrictMode>,
  )
})
