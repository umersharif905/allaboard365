# Open-Enroll Message Center

Azure Functions for processing messaging queue (email, SMS, push notifications) for the Open-Enroll platform.

## Overview

This Message Center runs as Azure Functions and handles:
- Processing the message queue every minute
- Sending scheduled messages (birthdays, reminders)
- Template rendering and provider communication
- Retry logic and failure handling

## Architecture

```
Backend App → writes to → messaging_outbox table
                              ↓
                    Timer Functions (every minute)
                              ↓
                    Processes and sends via
                              ↓
                 SendGrid (Email) / Twilio (SMS)
```

## Project Structure

```
messageCenter/
├── shared/                 # Shared utilities
│   ├── db.js              # Database connection
│   ├── templateEngine.js  # Handlebars template processing
│   └── providers/
│       ├── sendgrid.js    # SendGrid email provider
│       └── twilio.js      # Twilio SMS provider
├── worker-delivery/        # Main queue processor (runs every minute)
├── timer-birthdays/        # Daily birthday messages
├── timer-turns26/          # Dependent aging notifications
└── timer-ageband/          # Weekly pricing change notices
```

## Setup Instructions

### 1. Install Dependencies
```bash
cd messageCenter
npm install
```

### 2. Configure Environment
```bash
# Copy templates (real files are gitignored — do not commit secrets)
cp env.example .env
cp local.settings.json.example local.settings.json

# Edit .env and local.settings.json with your actual values
# - Database credentials
# - SendGrid API key
# - Twilio credentials
```

### 3. Run Locally
```bash
npm start
```

### 4. Deploy to Azure
```bash
# Deploy to production (uses prod DB via Azure app settings)
npm run deploy

# Deploy to staging/test (same code, different Function App with test DB in app settings)
npm run deploy:staging

# Or use deploy.sh with a custom app name
MESSAGE_CENTER_APP_NAME=allaboard-messagecenter-staging ./deploy.sh
```

**Testing vs production:** Use **two separate Azure Function Apps** (e.g. `allaboard-messagecenter` for prod, `allaboard-messagecenter-staging` for test). Same code; each app has its own Application Settings in Azure (DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD, etc.) pointing at prod or test DB. Do not configure one app to use both DBs—keeping them separate avoids mistakes and matches standard practice.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DB_USER` | SQL Server username | Yes |
| `DB_PASSWORD` | SQL Server password | Yes |
| `DB_SERVER` | SQL Server hostname | Yes |
| `DB_NAME` | Database name | Yes |
| `SENDGRID_API_KEY` | SendGrid API key | Yes |
| `SENDGRID_FROM_EMAIL` | Default from email | Yes |
| `TWILIO_ACCOUNT_SID` | Twilio account SID | Yes |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | Yes |
| `TWILIO_PHONE_NUMBER` | Twilio phone number | Yes |

## Functions

### worker-delivery
- **Schedule**: Every minute (`0 */1 * * * *`)
- **Purpose**: Process queued messages from `messaging_outbox`
- **Actions**: Send emails/SMS, update status, handle retries

### timer-birthdays
- **Schedule**: Daily at 9 AM (`0 0 9 * * *`)
- **Purpose**: Send birthday messages to members
- **Actions**: Query members with today's birthday, queue messages

### timer-turns26
- **Schedule**: Daily at 11 AM (`0 0 11 * * *`)
- **Purpose**: Notify about dependents turning 26
- **Actions**: Find dependents turning 26 soon, notify primary members

### timer-ageband
- **Schedule**: Weekly on Sundays at 9 AM (`0 0 9 * * 0`)
- **Purpose**: Check for age band pricing changes
- **Actions**: Identify members changing age bands, notify of pricing changes

## Database Tables

Schema changes (new columns, tables) are applied **on the SQL database** via scripts in the repo root `sql-changes/` when needed. **Message Center deployment does not run SQL**—the Function App only connects to whatever schema the database already has.

The functions interact with these tables:
- `oe.messaging_outbox` - Queue for messages to be sent
- `oe.messaging_templates` - Message templates by event type
- `oe.messaging_logs` - Delivery logs and status
- `oe.messaging_channels` - Channel configuration

## Monitoring

View function execution and logs:
- Azure Portal → Function App → Functions → Monitor
- Application Insights (if configured)
- Local development: Console output

## Troubleshooting

### Messages not sending
1. Check `messaging_outbox` table for stuck messages
2. Verify provider credentials in environment variables
3. Check function logs for errors

### Database connection issues
1. Verify SQL Server firewall rules
2. Check credentials in environment variables
3. Ensure database user has correct permissions

### Provider errors
1. SendGrid: Check API key and sender verification
2. Twilio: Verify account SID, auth token, and phone number

## Support

For issues or questions, contact the development team.