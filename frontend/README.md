# OpenEnroll Frontend

## Development Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Start the development server:
   ```
   npm run dev
   ```

## Testing Production Build Locally

1. Edit `src/config/api.ts` and uncomment this line:
   ```javascript
   // const env = 'development';
   ```

2. Build the production version:
   ```
   npm run build
   ```

3. Serve the production build:
   ```
   npx serve -s dist -l 3000
   ```

4. Make sure your backend server is running at http://localhost:3001

5. Test the application at http://localhost:3000

6. **IMPORTANT:** Before committing, re-comment the line in `src/config/api.ts`:
   ```javascript
   // const env = 'development';
   ```

## Production Deployment

1. Make sure `src/config/api.ts` has the development override commented out:
   ```javascript
   // const env = 'development';
   ```

2. Build the production version:
   ```
   npm run build
   ```

3. Deploy the contents of the `dist` folder to your production server

## Authentication Flow

The authentication flow works as follows:

1. User enters credentials on the login page
2. Frontend sends credentials to the auth server (typically the API host; see `OAUTH_URL` in `/config.json` or `VITE_OAUTH_URL`)
3. OAuth server validates credentials and returns access and refresh tokens
4. Frontend uses the access token to fetch user details from the main API (api.allaboard365.com)
5. User is redirected to the appropriate dashboard based on their role

## Environment Configuration

The application uses different API endpoints based on the environment:

- **Development**: API and auth go to `http://localhost:3001` unless overridden
- **Production**: API and OAuth base URL default to `https://api.allaboard365.com` (set `OAUTH_URL` in Azure `/config.json` if your auth host differs)

You can override this behavior by editing `src/config/api.ts`. 