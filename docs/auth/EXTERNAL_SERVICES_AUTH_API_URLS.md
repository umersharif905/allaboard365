# Auth & API URLs for External Services

This document describes the base URLs and authentication flow that external services (mobile apps, integrations, webhooks) must use when integrating with the platform.

## Overview

**Auth and API are co-located on the same backend.** There is no separate OAuth service. The backend serves both `/auth` (login, refresh, me, logout) and `/api` endpoints.

---

## Base URLs by Environment

| Environment | API Base URL | Auth Base URL (same as API) |
|-------------|--------------|-----------------------------|
| **Local** | `http://localhost:3001` | `http://localhost:3001` |
| **Development/QA** | `https://allaboard365-backend-ctehcsb5cbedauc0.centralus-01.azurewebsites.net` | Same |
| **Production** | `https://api.allaboard365.com` | Same |

**Important:** `OAUTH_URL` and `API_URL` should always be the same. Auth endpoints live at `{BASE_URL}/auth/...`.

---

## Authentication Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `{BASE_URL}/auth/login` | Login with email/password → `accessToken`, `refreshToken` |
| GET | `{BASE_URL}/auth/me` | Validate token, get current user |
| POST | `{BASE_URL}/auth/refresh` | Refresh access token (rotate refresh token) |
| POST | `{BASE_URL}/auth/logout` | Revoke session |

### Login Request

```http
POST {BASE_URL}/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "YourPassword"
}
```

### Login Response

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "abc123...",
  "roles": ["Member"],
  "tenantId": "...",
  "userId": "...",
  "email": "user@example.com",
  "firstName": "...",
  "lastName": "..."
}
```

---

## API Requests

All API calls require:

```
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Example:

```http
GET {BASE_URL}/api/me/member/profile
Authorization: Bearer eyJ...
```

---

## Configuration

Set these environment variables for the correct environment:

| Variable | Local | Production |
|----------|-------|------------|
| `VITE_API_URL` / `API_URL` | `http://localhost:3001` | `https://api.allaboard365.com` |
| `VITE_OAUTH_URL` / `OAUTH_URL` | `http://localhost:3001` | `https://api.allaboard365.com` |

The frontend fetches runtime config from `/config.json`; the backend serves this based on `VITE_API_URL`, `VITE_OAUTH_URL`, etc.
