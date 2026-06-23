// vite.config.production.ts
/**
 * Production Build Configuration
 * Optimized build settings for production deployment
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { resolve } from 'path'
import { copyFileSync, existsSync, writeFileSync } from 'fs'

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN
const sentryOrg = process.env.SENTRY_ORG
const sentryProject = process.env.SENTRY_PROJECT || 'openenroll-frontend'
const sentryRelease = process.env.SENTRY_RELEASE || process.env.VITE_APP_VERSION
const sentrySourceMapsEnabled = Boolean(
  sentryAuthToken && sentryOrg && sentryProject && process.env.SENTRY_UPLOAD_SOURCEMAPS !== 'false'
)

// Plugin to copy deployment files to dist after build
const copyDeploymentFiles = () => {
  return {
    name: 'copy-deployment-files',
    writeBundle() {
      // Copy deployment files after build completes
      try {
        // Copy .deployment
        if (existsSync('.deployment')) {
          copyFileSync('.deployment', 'dist/.deployment');
          console.log('✅ Copied .deployment');
        }
        
        // Always create/update server.js with Express server
        // In Azure, files are deployed directly to /home/site/wwwroot/
        const serverContent = `// Express server for serving frontend with runtime config.json endpoint
const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// IMPORTANT: /config.json route MUST be before static files middleware
// This ensures it's served correctly, not caught by static file serving
app.get('/config.json', (req, res) => {
  // Get API URL from environment variable
  // Support multiple variable names for flexibility
  const apiUrl = process.env.VITE_API_URL 
    || process.env.API_URL 
    || process.env.BASE_URL 
    || (() => {
      // If no API URL is set, try to construct from hostname
      // This is a fallback - always set VITE_API_URL explicitly in production
      const hostname = req.get('host') || req.hostname;
      if (hostname && hostname.includes('.')) {
        const parts = hostname.split('.');
        if (parts.length >= 2) {
          const rootDomain = parts.slice(-2).join('.');
          return 'https://api.' + rootDomain;
        }
      }
      return null;
    })();
  
  // Get OAuth URL from environment variable
  // Support multiple variable names for flexibility
  const oauthUrl = process.env.VITE_OAUTH_URL 
    || process.env.OAUTH_URL 
    || process.env.OAUTH_BASE_URL
    || (() => {
      // If no OAuth URL is set, try to construct from hostname
      // This is a fallback - always set VITE_OAUTH_URL explicitly in production
      const hostname = req.get('host') || req.hostname;
      if (hostname && hostname.includes('.')) {
        const parts = hostname.split('.');
        if (parts.length >= 2) {
          const rootDomain = parts.slice(-2).join('.');
          return 'https://oauth.' + rootDomain;
        }
      }
      return null;
    })();
  
  const appUrl = process.env.VITE_APP_URL || process.env.APP_URL || null;
  
  // Get brand identifier from environment variables
  // Priority: BRAND > VITE_BRAND
  const brand = (process.env.BRAND || process.env.VITE_BRAND || 'allaboard365').trim();
  
  // Log for debugging (without sensitive data)
  console.log('[Frontend Config] Environment check:', {
    hasVITE_API_URL: !!process.env.VITE_API_URL,
    hasAPI_URL: !!process.env.API_URL,
    hasBASE_URL: !!process.env.BASE_URL,
    hasVITE_OAUTH_URL: !!process.env.VITE_OAUTH_URL,
    hasOAUTH_URL: !!process.env.OAUTH_URL,
    hasOAUTH_BASE_URL: !!process.env.OAUTH_BASE_URL,
    hasBRAND: !!process.env.BRAND,
    hasVITE_BRAND: !!process.env.VITE_BRAND,
    resolvedApiUrl: apiUrl,
    resolvedOauthUrl: oauthUrl,
    resolvedBrand: brand
  });

  const config = {
    API_URL: apiUrl,
    BASE_URL: apiUrl, // Add BASE_URL alias for convenience
    OAUTH_URL: oauthUrl,
    APP_URL: appUrl,
    // Branding Configuration - ALWAYS include this
    BRAND: brand,
  };

  // Remove null/undefined values (but keep BRAND even if empty)
  Object.keys(config).forEach(key => {
    if (key !== 'BRAND' && (config[key] === null || config[key] === undefined)) {
      delete config[key];
    }
  });
  
  // Ensure BRAND is always present
  if (!config.BRAND) {
    config.BRAND = 'allaboard365';
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json(config);
});

// Serve static files from the current directory
// In Azure, files are deployed directly to /home/site/wwwroot/, so server.js
// and index.html are in the same directory
app.use(express.static(__dirname, {
  // Don't serve config.json as a static file if it exists
  index: false
}));

// SPA fallback: serve index.html for all routes that don't match static files
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(\`Frontend running on port \${port}\`);
});
`;
        writeFileSync('dist/server.js', serverContent);
        console.log('✅ Created/updated server.js');
        
        // Always create/update package.json for Azure deployment
        const packageContent = {
          "name": "allaboard365-frontend",
          "version": "1.0.0",
          "description": "Open-Enroll Frontend React App",
          "main": "server.js",
          "scripts": {
            "start": "node server.js"
          },
          "engines": {
            "node": "22.x"
          },
          "dependencies": {
            "express": "^4.18.2"
          }
        };
        writeFileSync('dist/package.json', JSON.stringify(packageContent, null, 2));
        console.log('✅ Created/updated package.json');
        
        console.log('✅ Deployment files ready in dist');
      } catch (e) {
        console.log('⚠️ Could not copy deployment files:', e.message);
      }
    }
  };
};

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(sentrySourceMapsEnabled
      ? [
          sentryVitePlugin({
            org: sentryOrg,
            project: sentryProject,
            authToken: sentryAuthToken,
            release: {
              name: sentryRelease,
            },
            sourcemaps: {
              filesToDeleteAfterUpload: ['./dist/**/*.map'],
            },
          }),
        ]
      : []),
    copyDeploymentFiles()
  ],
  
  build: {
    // Production optimizations
    minify: 'terser',
    terserOptions: {
      compress: {
        // Strip console.* from the client bundle when building with --mode production
        drop_console: mode === 'production',
        drop_debugger: true,
        dead_code: true,
        unused: true
      }
    },
    
    // Bundle splitting for better caching
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          router: ['react-router-dom'],
          ui: ['lucide-react']
        }
      }
    },
    
    // Asset optimization
    assetsInlineLimit: 4096,
    cssCodeSplit: true,
    // Hidden source maps are uploaded to Sentry during build when SENTRY_AUTH_TOKEN is set.
    sourcemap: sentrySourceMapsEnabled ? 'hidden' : false,
    
    // Bundle size limits
    chunkSizeWarningLimit: 1000,
    
    // Output directory
    outDir: 'dist',
    emptyOutDir: true
  },
  
  // Environment variables
  // Note: Don't hardcode NODE_ENV here - let Vite's --mode flag control it
  define: {
    __DEV__: false
  },
  
  // Server configuration for Azure App Service
  server: {
    port: 3000,
    host: true
  },
  
  // Preview configuration
  preview: {
    port: 3000,
    host: true
  },
  
  // Path resolution
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@components': resolve(__dirname, 'src/components'),
      '@pages': resolve(__dirname, 'src/pages'),
      '@services': resolve(__dirname, 'src/services'),
      '@hooks': resolve(__dirname, 'src/hooks'),
      '@utils': resolve(__dirname, 'src/utils'),
      '@types': resolve(__dirname, 'src/types')
    }
  }
}))
