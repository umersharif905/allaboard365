#!/usr/bin/env node
/**
 * Pre-deploy checks so the backend cannot ship with module paths that work locally
 * (repo-root shared/) but crash on Azure (wwwroot = backend/ only, shared/ bundled).
 *
 * Usage:
 *   node scripts/validate-deploy.js           # static analysis
 *   node scripts/validate-deploy.js --smoke   # after backend/shared exists; simulates Azure
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_SHARED_ROOT = path.join(BACKEND_ROOT, '..', 'shared');
const BUNDLED_SHARED_ROOT = path.join(BACKEND_ROOT, 'shared');

const SKIP_DIRS = new Set(['node_modules', '.git', 'uploads', 'temp', 'bkp']);
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Repo-root shared packages (copied into backend/shared by deploy.sh). */
function getRepoSharedPackages() {
  if (!fs.existsSync(REPO_SHARED_ROOT)) {
    console.error(`Error: repo shared/ not found at ${REPO_SHARED_ROOT}`);
    process.exit(1);
  }
  return fs
    .readdirSync(REPO_SHARED_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      const pkgDir = path.join(REPO_SHARED_ROOT, name);
      return (
        fs.existsSync(path.join(pkgDir, 'index.js')) ||
        fs.existsSync(path.join(pkgDir, 'package.json'))
      );
    });
}

function isInternalBackendSharedSpec(spec) {
  return /(?:^|\/)(?:services\/shared|routes\/shared)(?:\/|$)/.test(spec);
}

function repoSharedPackageInSpec(spec, packages) {
  if (isInternalBackendSharedSpec(spec)) return null;
  for (const pkg of packages) {
    if (spec.includes(`shared/${pkg}`) || spec === `shared/${pkg}`) {
      return pkg;
    }
  }
  return null;
}

function walkJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function staticAnalysis() {
  const packages = getRepoSharedPackages();
  const violations = [];

  for (const filePath of walkJsFiles(BACKEND_ROOT)) {
    const relFile = path.relative(BACKEND_ROOT, filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    let match;
    REQUIRE_RE.lastIndex = 0;
    while ((match = REQUIRE_RE.exec(content)) !== null) {
      const spec = match[1];
      const pkg = repoSharedPackageInSpec(spec, packages);
      if (!pkg) continue;

      const resolved = path.resolve(path.dirname(filePath), spec);
      const inBundled = resolved.startsWith(BUNDLED_SHARED_ROOT + path.sep);
      const inRepoOnly =
        resolved.startsWith(REPO_SHARED_ROOT + path.sep) && !inBundled;

      if (inRepoOnly) {
        violations.push({
          file: relFile,
          spec,
          pkg,
          resolved,
          hint: `Use requireShared('${pkg}') from config/shared-modules.js instead of a relative path to repo shared/.`,
        });
      }
    }
  }

  if (violations.length) {
    console.error('\n❌ Deploy blocked: repo-root shared/ imports that will fail on Azure:\n');
    for (const v of violations) {
      console.error(`  ${v.file}`);
      console.error(`    require("${v.spec}")`);
      console.error(`    → ${v.resolved}`);
      console.error(`    ${v.hint}\n`);
    }
    process.exit(1);
  }

  console.log(
    `✅ Static check: no repo-only shared/ requires (${packages.join(', ')})`
  );
}

/** Load modules the way Azure does — backend/shared only, not ../shared. */
function smokeTest() {
  if (!fs.existsSync(BUNDLED_SHARED_ROOT)) {
    console.error(
      'Error: backend/shared is missing. Run ensure-shared or deploy bundle step before --smoke.'
    );
    process.exit(1);
  }

  const packages = getRepoSharedPackages();
  const origResolve = Module._resolveFilename;

  Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
    const resolved = origResolve.call(this, request, parent, isMain, options);
    const parentFile = parent?.filename || '';

    if (
      resolved.startsWith(REPO_SHARED_ROOT + path.sep) &&
      !resolved.startsWith(BUNDLED_SHARED_ROOT + path.sep)
    ) {
      const err = new Error(
        `Azure deploy would fail: "${request}" resolved to repo shared/\n` +
          `  from: ${parentFile}\n` +
          `  at:   ${resolved}\n` +
          `  Use requireShared() from config/shared-modules.js.`
      );
      err.code = 'DEPLOY_SHARED_PATH';
      throw err;
    }

    return resolved;
  };

  const smokeModules = [
    '../config/shared-modules.js',
    '../routes/payments.js',
    '../routes/groupBilling.js',
    '../services/dimeService.js',
    '../services/paymentDatabaseService.js',
    '../services/publicFormSubmissionService.js',
    '../routes/enrollment-links.js',
    '../routes/accounting/vendor-breakdown.js',
  ];

  try {
    for (const mod of smokeModules) {
      const abs = path.join(__dirname, mod);
      delete require.cache[abs];
      require(abs);
    }
    const { requireShared } = require('../config/shared-modules');
    for (const pkg of packages) {
      requireShared(pkg);
    }
    console.log(
      `✅ Smoke test: ${smokeModules.length} modules + ${packages.length} requireShared packages load with bundled shared/ only`
    );
  } catch (e) {
    console.error('\n❌ Deploy blocked: Azure module resolution smoke test failed:\n');
    console.error(e.stack || e.message);
    process.exit(1);
  } finally {
    Module._resolveFilename = origResolve;
  }
}

function main() {
  const smoke = process.argv.includes('--smoke');
  staticAnalysis();
  if (smoke) {
    smokeTest();
  } else {
    console.log('   (Run again with --smoke after backend/shared is bundled.)');
  }
}

main();
