/**
 * Ensures backend/shared exists (copy from repo-root shared/).
 * Deploy copies shared into the zip; locally we sync from ../shared once.
 */
const fs = require('fs');
const path = require('path');

const backendDir = path.join(__dirname, '..');
const dest = path.join(backendDir, 'shared');
const repoShared = path.join(backendDir, '..', 'shared');

function hasPaymentStatus(dir) {
  try {
    return fs.existsSync(path.join(dir, 'payment-status', 'index.js'));
  } catch {
    return false;
  }
}

if (hasPaymentStatus(dest)) {
  process.exit(0);
}
if (hasPaymentStatus(repoShared)) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(repoShared, dest, { recursive: true });
  process.exit(0);
}
console.warn(
  '[ensure-shared] Neither backend/shared nor repo shared/ found; payment-status may fail.'
);
process.exit(0);
