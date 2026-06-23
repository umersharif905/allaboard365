OAuth 2.0 API Documentation
🔐 OAuth 2.0 API Documentation
🌐 Base URL
https://api.allaboard365.com/auth (or your configured `OAUTH_URL`; auth is served by the API, not a separate `oauth.*` subdomain)
🔑 Authentication Overview
This API implements a secure OAuth 2.0 token system using:
- Access Tokens (1-hour expiry)
- Refresh Tokens (7-day expiry, rotated on use)
-
 Secure password reset
- Full session and audit logging
All endpoints that require authentication must include this header:
Authorization: Bearer <accessToken>
📌 Endpoints
1. 📝 Register
POST /auth/register
Request Body:
{
 "email": "user@example.com",
 "password": "P@ssw0rd123",
 "firstName": "John",
 "lastName": "Doe"
}
Response:
{
 "message": "User registered successfully",
 "userId": "<GUID>"
}
2. 🔐 Login
POST /auth/login
Request Body:
{
 "email": "user@example.com",
 "password": "P@ssw0rd123"
}
Response:
{
 "accessToken": "...",
 "refreshToken": "..."
}
3. 🔁 Refresh Token
POST /auth/refresh
Request Body:
{
"refreshToken": "..."
}
Response:
{
 "accessToken": "...",
 "refreshToken": "..."
}
> Refresh token is rotated. Discard the old one.
4. 🚪 Logout
POST /auth/logout
Request Body:
{
 "refreshToken": "..."
}
Response:
{
 "message": "Logout successful. Token revoked."
}
5. 👤 Get Current User Info
GET /auth/me
Headers:
Authorization: Bearer <accessToken>
Response:
{
 "message": "Authenticated",
 "user": {
 "userId": "...",
 "email": "user@example.com"
}
}
6. 📧 Request Password Reset
POST /auth/request-reset
Request Body:
{
 "email": "user@example.com"
}
Response:
{
 "message": "Reset token generated",
"resetToken": "..."
}
> This token is valid for 15 minutes. Send via email in production.
7. 🔁 Reset Password
POST /auth/reset-password
Request Body:
{
 "token": "<resetToken>",
 "newPassword": "NewP@ss123"
}
Response:
{
 "message": "Password reset successful"
}
📊 Audit Logging
All authentication actions are logged into oe.AuthLog including:
- Login
- Logout
- Refresh
- ResetRequest
-
 PasswordReset
Each log includes:
- UserId
- Email
- Action
- Success
- Message
- IPAddress
-
 UserAgent
- CreatedAt
⏳ Token Policy Summary
Token Type | Lifetime | Renewability | Storage
---------------|----------|---------------|-----------------
 Access Token | 1 hour | No | Client memory
 Refresh Token | 7 days | Yes (rotated) | Secure storage
❗ Error Responses (Examples)
{
"message": "Invalid credentials"
}
{
 "message": "Invalid or expired refresh token"
}
{
 "message": "Token not found or already revoked"
}
{
 "message": "Invalid or expired token"
}
✅ Final Notes
- Always use HTTPS
- Store refresh tokens securely (e.g., HTTP-only cookies on web)
- Access tokens must be refreshed proactively before expiration