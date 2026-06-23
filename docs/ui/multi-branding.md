# Multi-Branding Support Documentation

## Overview

The Open-Enroll platform supports multi-branding, allowing the same codebase to display different color themes, logos, and branding assets for different URLs/platforms. This is controlled via environment variables and supports runtime brand switching without requiring a rebuild.

## Architecture

### Brand Configuration System

Brands are defined in `frontend/src/config/branding-configs.ts`. Each brand has:
- **Colors**: Primary, secondary, and semantic colors
- **Logos**: Main, light, dark, icon, and favicon variants
- **Metadata**: Name, tagline, support email, company URL

### Runtime Configuration

The brand is determined at runtime through the following priority:
1. **Runtime config** from `/config.json` endpoint (BRAND environment variable)
2. **Build-time config** from `VITE_BRAND` environment variable
3. **Default brand** (`allaboard365`)

### Branding Context

The `BrandingContext` React context provides branding information to all components:
- Current brand identifier
- Brand colors (applied as CSS variables)
- Logo paths
- Helper functions to get brand-specific assets

## Adding a New Brand

### Step 1: Create Brand Configuration

Add a new brand entry to `frontend/src/config/branding-configs.ts`:

```typescript
export const BRAND_CONFIGS: Record<string, BrandConfig> = {
  'allaboard365': { /* existing config */ },
  'your-brand': {
    name: 'Your Brand Name',
    colors: {
      primary: '#ff6b6b',
      primaryLight: '#ffe0e0',
      primaryDark: '#cc0000',
      secondary: '#4ecdc4',
      neutralLight: '#f7f9fa',
      neutralDark: '#2b2b2b',
      success: '#4caf50',
      error: '#e53935',
      warning: '#ffb300',
    },
    logos: {
      main: '/images/branding/your-brand/logo.svg',
      light: '/images/branding/your-brand/logo-light.svg',
      dark: '/images/branding/your-brand/logo-dark.svg',
      icon: '/images/branding/your-brand/icon.svg',
      favicon: '/images/branding/your-brand/favicon.ico',
    },
    tagline: 'Your Brand Tagline',
    supportEmail: 'support@yourbrand.com',
    companyUrl: 'https://yourbrand.com',
  },
};
```

### Step 2: Create Brand Asset Directory

Create a directory for your brand assets:

```bash
mkdir -p frontend/public/images/branding/your-brand
```

### Step 3: Add Brand Assets

Place the following files in `frontend/public/images/branding/your-brand/`:
- `logo.svg` - Main logo (used by default)
- `logo-light.svg` - Light variant (for dark backgrounds)
- `logo-dark.svg` - Dark variant (for light backgrounds)
- `icon.svg` - Icon/thumbnail version
- `favicon.ico` - Browser favicon

### Step 4: Set Environment Variable

Set the `BRAND` or `VITE_BRAND` environment variable to your brand identifier:

**Azure App Service:**
- Go to Configuration → Application Settings
- Add: `BRAND` = `your-brand`

**Local Development (.env file):**
```env
VITE_BRAND=your-brand
```

## Using Branding in Components

### Accessing Branding Context

```typescript
import { useBranding } from '../contexts/BrandingContext';

const MyComponent = () => {
  const { brand, config, logos, colors, getLogo } = useBranding();
  
  return (
    <div>
      <img src={getLogo('main')} alt={config.name} />
      <h1 style={{ color: colors.primary }}>{config.name}</h1>
    </div>
  );
};
```

### Logo Types

The `getLogo()` function accepts:
- `'main'` - Main logo
- `'light'` - Light variant
- `'dark'` - Dark variant
- `'icon'` - Icon version
- `'favicon'` - Favicon

### CSS Variables

Brand colors are automatically applied as CSS variables:
- `--oe-primary` - Primary brand color
- `--oe-primary-light` - Light variant
- `--oe-primary-dark` - Dark variant
- `--oe-secondary` - Secondary color (if defined)
- `--oe-neutral-light` - Light neutral
- `--oe-neutral-dark` - Dark neutral
- `--oe-success` - Success color
- `--oe-error` - Error color
- `--oe-warning` - Warning color

Use these in your Tailwind classes or CSS:
```css
.my-button {
  background-color: var(--oe-primary);
  color: white;
}
```

## Backend Configuration

### Config Endpoint

The backend serves `/config.json` which includes:
- `BRAND` - Current brand identifier
- `API_URL` - API endpoint
- `OAUTH_URL` - OAuth endpoint
- `APP_URL` - Application URL

**Endpoint:** `GET /config.json` (public, no authentication required)

### Environment Variables

The backend reads brand configuration from:
- `BRAND` (preferred)
- `VITE_BRAND` (fallback)

## Tenant Branding vs Platform Branding

The system supports two levels of branding:

1. **Platform Branding** (Multi-Branding)
   - Controlled by `BRAND` environment variable
   - Applies to the entire platform/URL
   - Defined in `branding-configs.ts`
   - Applied via `BrandingContext`

2. **Tenant Branding** (Custom Domain Branding)
   - Controlled by tenant settings in database
   - Applies to specific custom domains
   - Overrides platform branding when present
   - Handled by `DomainTenantHandler`

**Priority:** Tenant branding > Platform branding

When a tenant has custom branding (via custom domain), it takes precedence over platform branding.

## Deployment Considerations

### Azure App Service

1. **Set Environment Variables:**
   - Go to Configuration → Application Settings
   - Add: `BRAND` = `your-brand-name`
   - Add: `VITE_API_URL` = `https://api.yourdomain.com`
   - Add: `VITE_OAUTH_URL` = `https://oauth.yourdomain.com`

2. **Asset Deployment:**
   - All brand assets are included in the build
   - No separate builds needed per brand
   - Same codebase, different runtime config

3. **Multiple Deployments:**
   - Deploy the same codebase to different App Services
   - Set different `BRAND` values per deployment
   - Each deployment can serve a different brand

### Build Process

The build process:
1. Includes all brand assets in the build
2. Does NOT hardcode brand at build time
3. Determines brand at runtime from `/config.json`
4. Allows brand switching without rebuild

### Testing

**Local Development:**
```bash
# Set brand in .env file
VITE_BRAND=your-brand

# Or set environment variable
$env:VITE_BRAND="your-brand"
npm run dev
```

**Verify Brand:**
1. Check browser console for `[BrandingContext] Brand initialized: your-brand`
2. Check `/config.json` endpoint returns correct `BRAND`
3. Verify logos load from correct paths
4. Verify colors are applied correctly

## File Structure

```
frontend/
├── src/
│   ├── config/
│   │   ├── branding.ts              # Brand loader
│   │   └── branding-configs.ts      # Brand definitions
│   ├── contexts/
│   │   └── BrandingContext.tsx      # React context
│   ├── constants/
│   │   └── images.ts                # Image paths (fallback)
│   └── styles/
│       └── theme.css                # CSS variables
└── public/
    └── images/
        └── branding/
            ├── allaboard365/          # AllAboard365 brand assets
            │   ├── logo.svg
            │   ├── logo-light.svg
            │   ├── logo-dark.svg
            │   ├── icon.svg
            │   └── favicon.ico
            └── your-brand/           # Your brand assets
                └── ...

backend/
└── routes/
    └── config.js                     # /config.json endpoint
```

## Troubleshooting

### Brand Not Loading

1. **Check Environment Variable:**
   ```bash
   # Backend
   echo $BRAND
   
   # Frontend (build-time)
   echo $VITE_BRAND
   ```

2. **Check /config.json Endpoint:**
   ```bash
   curl http://localhost:3001/config.json
   ```
   Should return: `{ "BRAND": "your-brand", ... }`

3. **Check Browser Console:**
   Look for `[BrandingContext]` logs

### Logos Not Loading

1. **Verify File Paths:**
   - Check files exist in `public/images/branding/your-brand/`
   - Verify paths in `branding-configs.ts` match actual files

2. **Check Browser Network Tab:**
   - Look for 404 errors on logo requests
   - Verify paths are correct

### Colors Not Applying

1. **Check CSS Variables:**
   ```javascript
   getComputedStyle(document.documentElement).getPropertyValue('--oe-primary')
   ```

2. **Check Data Attribute:**
   ```javascript
   document.documentElement.getAttribute('data-brand')
   ```

3. **Verify BrandingContext:**
   - Ensure `BrandingProvider` wraps your app
   - Check context is not undefined

## Future Extensibility

The system can be extended to support:
- **Brand-specific fonts** - Add `fonts` property to `BrandConfig`
- **Brand-specific UI components** - Use `data-brand` attribute for conditional rendering
- **Brand-specific feature flags** - Add `features` property to `BrandConfig`
- **Brand-specific translations** - Add `translations` property to `BrandConfig`

## Examples

### Example: Adding "Brand2"

1. **Add to `branding-configs.ts`:**
```typescript
'brand2': {
  name: 'Brand 2',
  colors: {
    primary: '#ff6b6b',
    primaryLight: '#ffe0e0',
    primaryDark: '#cc0000',
    // ... other colors
  },
  logos: {
    main: '/images/branding/brand2/logo.svg',
    // ... other logos
  },
}
```

2. **Create assets directory:**
```bash
mkdir -p frontend/public/images/branding/brand2
```

3. **Add logo files**

4. **Set environment variable:**
```bash
BRAND=brand2
```

5. **Deploy and test**

## Support

For questions or issues with multi-branding:
1. Check this documentation
2. Review `branding-configs.ts` for examples
3. Check browser console for branding logs
4. Verify `/config.json` endpoint returns correct brand
