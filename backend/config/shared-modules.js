/**
 * Resolve repo-root shared/ packages for local dev (../../shared) and Azure
 * (backend/shared copied by deploy.sh). Do not use ../shared from services/routes
 * — that only exists after deploy copy.
 */
const path = require('path');

function requireShared(pkg) {
  const backendRoot = path.join(__dirname, '..');
  const bundled = path.join(backendRoot, 'shared', pkg);
  const repo = path.join(backendRoot, '..', 'shared', pkg);
  try {
    return require(bundled);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
  }
  return require(repo);
}

module.exports = { requireShared };
