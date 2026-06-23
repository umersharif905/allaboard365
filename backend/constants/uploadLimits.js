'use strict';

/**
 * Per-file byte limits for multer. Keep in sync with `frontend/src/constants/uploads.ts`.
 */
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;

/** Census CSV/XLSX, vendor share-request attachments, large imports. */
const MAX_LARGE_UPLOAD_BYTES = 100 * 1024 * 1024;

module.exports = {
  MAX_UPLOAD_FILE_BYTES,
  MAX_LARGE_UPLOAD_BYTES,
};
