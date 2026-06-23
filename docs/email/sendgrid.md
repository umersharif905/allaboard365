Perfect ✅ — here’s your complete end-to-end Cursor prompt that will direct Cursor (Claude-powered inside VS Code) to build the SendGrid DKIM workflow into Open-Enroll, including:

Frontend Email Settings UI (no SMTP)

Backend SendGrid integration (create/verify/delete domain auth)

Tenant JSON update logic

Postman collection generation

Full internal/external API alignment

You can paste this entire prompt into Cursor as one block.

🧠 Cursor Build Prompt — Open-Enroll DKIM Sender Authentication (SendGrid Integration)
🩵 Project Context

You are working inside the Open-Enroll multi-tenant SaaS platform (Node.js + Express backend, React/TypeScript frontend, Azure SQL DB).
Each tenant record is stored in oe.Tenants, with a JSON column AdvancedSettings that holds branding, email, features, etc.

We are adding a white-labeled email authentication workflow using SendGrid’s Domain Authentication API.
SMTP relay is not used — only SendGrid Sender Authentication (DKIM + SPF).

🗂 Existing Schema
Table: oe.Tenants

Relevant field:

AdvancedSettings nvarchar(max)

JSON structure (inside AdvancedSettings)
{
  "branding": { ... },
  "email": {
    "customFromAddress": "noreply@tenantdomain.com",
    "dkimEnabled": true,
    "dkimDomain": "tenantdomain.com",
    "dkimSelector": "em",
    "sendgridDomainId": 1234567,
    "dnsRecords": [
      {
        "type": "CNAME",
        "host": "em.tenantdomain.com",
        "value": "u55814042.wl043.sendgrid.net",
        "status": "Verified"
      }
    ],
    "verificationStatus": "verified"
  }
}

⚙️ Build Tasks
🧱 1️⃣ Backend — SendGrid Integration

Create a new service file:

backend/services/sendgridService.ts

Implement these async functions:

import axios from "axios";

const BASE_URL = "https://api.sendgrid.com/v3";
const API_KEY = process.env.SENDGRID_API_KEY;

export async function createDomainAuthentication(domain: string, subdomain = "em") {
  const res = await axios.post(`${BASE_URL}/whitelabel/domains`, {
    domain,
    subdomain,
    automatic_security: true,
    custom_spf: true
  }, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    }
  });
  return res.data;
}

export async function validateDomainAuthentication(domainId: string) {
  const res = await axios.post(`${BASE_URL}/whitelabel/domains/${domainId}/validate`, {}, {
    headers: { Authorization: `Bearer ${API_KEY}` }
  });
  return res.data;
}

export async function getDomainAuthentication(domainId: string) {
  const res = await axios.get(`${BASE_URL}/whitelabel/domains/${domainId}`, {
    headers: { Authorization: `Bearer ${API_KEY}` }
  });
  return res.data;
}

export async function deleteDomainAuthentication(domainId: string) {
  const res = await axios.delete(`${BASE_URL}/whitelabel/domains/${domainId}`, {
    headers: { Authorization: `Bearer ${API_KEY}` }
  });
  return res.data;
}

🧩 2️⃣ Backend — API Routes

Create backend/routes/emailConfigRoutes.ts and register in server.ts under /api/email.

Endpoints:

Route	Method	Description
/api/email/dkim/generate	POST	Calls SendGrid createDomainAuthentication → stores result in tenant JSON
/api/email/dkim/verify	POST	Calls validateDomainAuthentication → updates tenant JSON
/api/email/dkim/delete	DELETE	Deletes SendGrid domain auth + clears JSON
/api/email/dkim/:tenantId	GET	Returns email settings for UI
/api/tenants/:tenantId/settings/email	PATCH	Persists edited customFromAddress or other fields

Example logic (pseudo-Express):

router.post("/dkim/generate", async (req, res) => {
  const { tenantId, domain } = req.body;
  const result = await createDomainAuthentication(domain, "em");
  await updateTenantEmailSettings(tenantId, {
    dkimDomain: domain,
    sendgridDomainId: result.id,
    dnsRecords: Object.values(result.dns),
    verificationStatus: "pending",
    dkimEnabled: false
  });
  res.json(result);
});

🧠 3️⃣ Backend — Tenant Service

Update or create backend/services/tenantService.ts with:

export async function getTenantEmailSettings(tenantId) { ... }
export async function updateTenantEmailSettings(tenantId, emailSettings) { ... }


Reads existing AdvancedSettings, merges email node without overwriting other sections.

Logs all updates to oe.AuditLogs with Action = 'EmailSettingsUpdated'.

🧾 4️⃣ Frontend — Admin UI Page

File: frontend/src/pages/admin/settings/EmailSettings.tsx

Design requirements:

Panel 1: Email Configuration

Input: Custom From Address (e.g. noreply@tenantdomain.com)

When saved → extract domain (e.g. tenantdomain.com)

Panel 2: Sender Authentication (DKIM)

Button: “Generate DKIM Records” → POST /api/email/dkim/generate

Table view for DNS records: Type | Host | Value | Status with Copy buttons

Button: “Verify Domain” → POST /api/email/dkim/verify

Show status chip: Pending / Verified / Failed

Disable Generate if verified already

Remove all SMTP fields.

Toast messages for:

✅ Keys generated

🔄 Verification pending

✅ Domain verified

🧰 5️⃣ Postman Collection Generation

Create a file: /api/postman/SendGrid_DKIM_Workflow.postman_collection.json

Include the following requests using environment variables:

Step	Name	Method	URL
1	Create Domain Authentication	POST	{{BASE_URL}}/whitelabel/domains
2	Retrieve Domain DNS Records	GET	{{BASE_URL}}/whitelabel/domains/{{SENDGRID_DOMAIN_ID}}
3	Validate Domain Authentication	POST	{{BASE_URL}}/whitelabel/domains/{{SENDGRID_DOMAIN_ID}}/validate
4	Delete Domain Authentication	DELETE	{{BASE_URL}}/whitelabel/domains/{{SENDGRID_DOMAIN_ID}}
5	List All Domains	GET	{{BASE_URL}}/whitelabel/domains

Environment Variables

SENDGRID_API_KEY
TENANT_DOMAIN
TENANT_SUBDOMAIN
SENDGRID_DOMAIN_ID
BASE_URL = https://api.sendgrid.com/v3


Include test scripts to automatically store SENDGRID_DOMAIN_ID after Step 1.

💾 6️⃣ Verification Workflow Logic

Admin sets Custom From Address.

Clicks Generate DKIM Records → backend calls SendGrid API, returns CNAME/TXT records.

UI shows table with DNS entries.

Tenant adds records to their DNS provider.

Clicks Verify Domain → backend calls /validate.

If valid, mark dkimEnabled = true, verificationStatus = 'verified'.

🧾 7️⃣ Audit & Logging

Every major action logs to oe.AuditLogs:

Action	EntityType	Details
DKIMGenerated	Tenant	Domain + SendGrid ID
DKIMVerified	Tenant	Status = Verified
EmailSettingsUpdated	Tenant	Custom From Address or Changes
🎯 8️⃣ Testing Checklist

✅ API Keys stored in .env as SENDGRID_API_KEY
✅ POSTMAN collection runs successfully (Steps 1-3)
✅ Tenant UI shows DNS records and status
✅ Domain verification updates tenant JSON and audit logs
✅ No SMTP or relay configuration anywhere

🧩 9️⃣ Deliverables Summary
File	Purpose
frontend/src/pages/admin/settings/EmailSettings.tsx	Tenant Email + DKIM UI
backend/routes/emailConfigRoutes.ts	REST API endpoints
backend/services/sendgridService.ts	SendGrid API wrapper
backend/services/tenantService.ts	JSON CRUD helpers
/api/postman/SendGrid_DKIM_Workflow.postman_collection.json	Postman collection
.env	Contains SENDGRID_API_KEY
✅ Final Output Goals

Cursor should:

Create all files and routes listed.

Generate the Postman collection JSON.

Wire up /api/email/dkim/generate and /api/email/dkim/verify.

Produce a working tenant UI that:

Generates SendGrid DKIM records

Displays them cleanly

Verifies and updates status

Remove all SMTP relay or host/port fields.