// Shared lead-ingest endpoint + sample curl helpers, so SourceCreateModal and the
// API source detail view render identical guidance to Jeremy's LeadIngestModal.
export const LEAD_INGEST_URL = 'https://api.allaboard365.com/api/lead-ingest';

export const sampleCurl = (key?: string | null) =>
  `curl -X POST ${LEAD_INGEST_URL} \\
  -H "Authorization: Bearer ${key || 'sk_live_...'}" \\
  -H "Content-Type: application/json" \\
  -d '{"firstName":"Jane","lastName":"Doe","email":"jane@example.com","phone":"2015551234","referralName":"Website","premiumAmount":250}'`;
