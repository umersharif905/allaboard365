#!/usr/bin/env node
/**
 * Prints bash `export KEY='...'` lines for ai_scripts/.env so migrate-bacpac-with-sanitize.sh
 * can `eval` them safely (passwords with $ and quotes; avoids naive grep|xargs).
 *
 * Usage: eval "$(node ai_scripts/print-dotenv-exports.cjs)"
 * Env:   AI_SCRIPTS_ENV_FILE — optional override path to the .env file
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const dotenv = require(path.join(repoRoot, 'backend/node_modules/dotenv'));

const envPath =
  process.env.AI_SCRIPTS_ENV_FILE || path.join(__dirname, '.env');

if (!fs.existsSync(envPath)) {
  console.error('print-dotenv-exports: missing file:', envPath);
  process.exit(1);
}

const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));

/** Bash-safe single-quoted string for export VAR='...' */
function shellSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

for (const key of Object.keys(parsed)) {
  const val = parsed[key];
  if (val === undefined) continue;
  // Skip comment-only or malformed keys dotenv might leave out
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
  process.stdout.write(`export ${key}=${shellSingleQuote(val)}\n`);
}
