/** Per-file limit for most uploads; keep in sync with `backend/constants/uploadLimits.js` */
export const MAX_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_UPLOAD_MB = 25;

/** Larger cap (census import, vendor share-request attachments); sync with backend `MAX_LARGE_UPLOAD_BYTES` */
export const MAX_LARGE_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_LARGE_UPLOAD_MB = 100;

/** Vendor import (eligibility CSV, Sharewell ZIP parse/commit); sync with backend import route timeouts */
export const VENDOR_IMPORT_TIMEOUT_MS = 30 * 60 * 1000;
