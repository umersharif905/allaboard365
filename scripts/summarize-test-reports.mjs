#!/usr/bin/env node
/**
 * Build test-reports/summary.txt from jest.json, vitest.json, cypress-runs.jsonl.
 * Failures only — safe to paste instead of full terminal logs.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = process.env.OE_TEST_REPORT_DIR || path.join(ROOT, 'test-reports');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function firstLine(text, max = 240) {
  if (!text) return '';
  const line = String(text).split('\n').find((l) => l.trim()) || '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function summarizeJest(data) {
  if (!data) return { ran: false, passed: 0, failed: 0, failures: [] };
  const failures = [];
  for (const suite of data.testResults || []) {
    for (const t of suite.assertionResults || []) {
      if (t.status === 'failed') {
        failures.push({
          spec: suite.name?.replace(ROOT, '') || suite.name,
          test: t.fullName || t.title,
          message: firstLine((t.failureMessages || []).join('\n')),
        });
      }
    }
  }
  return {
    ran: true,
    passed: data.numPassedTests ?? 0,
    failed: data.numFailedTests ?? failures.length,
    failures,
  };
}

function summarizeVitest(data) {
  if (!data) return { ran: false, passed: 0, failed: 0, failures: [] };
  const failures = [];
  const files = data.testResults || data.files || [];
  for (const file of files) {
    const filePath = file.name || file.filePath || file.id || 'unknown';
    const tests = file.assertionResults || file.tasks || file.tests || [];
    for (const t of tests) {
      const status = t.status || t.result?.state;
      if (status === 'fail' || status === 'failed') {
        failures.push({
          spec: String(filePath).replace(ROOT, ''),
          test: t.fullName || t.name || t.title,
          message: firstLine(t.failureMessages?.join?.('\n') || t.error?.message || t.message),
        });
      }
    }
  }
  const failed = data.numFailedTests ?? failures.length;
  const passed = data.numPassedTests ?? data.numPassedTestSuites ?? 0;
  return { ran: true, passed, failed, failures };
}

function summarizeCypressRuns(jsonlPath) {
  if (!fs.existsSync(jsonlPath)) {
    return { runs: 0, passed: 0, failed: 0, pending: 0, failures: [] };
  }
  const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const failures = [];

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const results = row.results;
    if (!results || results.status === 'failed') {
      failures.push({
        spec: '(cypress run failed to start)',
        test: results?.message || row.at || 'unknown',
        message: results?.message || '',
        screenshot: null,
        video: null,
      });
      failed += results?.failures ?? 1;
      continue;
    }
    passed += results.totalPassed ?? 0;
    failed += results.totalFailed ?? 0;
    pending += results.totalPending ?? 0;

    for (const run of results.runs || []) {
      const specRel = run.spec?.relative || run.spec?.name || 'unknown';
      const specBase = path.basename(specRel, path.extname(specRel));
      for (const test of run.tests || []) {
        if (test.state !== 'failed') continue;
        const title = Array.isArray(test.title) ? test.title.join(' › ') : test.title;
        failures.push({
          spec: specRel,
          test: title,
          message: firstLine(test.displayError),
          screenshot: `frontend/cypress/screenshots/${specBase}.cy.ts (or .cy.js)`,
          video: `frontend/cypress/videos/${specRel.replace(/^cypress\/e2e\//, '').replace(/\.cy\.(ts|js)$/, '.cy.ts.mp4')}`,
        });
      }
    }
  }

  return { runs: lines.length, passed, failed, pending, failures };
}

function formatSection(title, block) {
  const lines = [`## ${title}`];
  if (!block.ran && block.runs === 0) {
    lines.push('(not run this session)');
    return lines;
  }
  if (block.runs !== undefined) {
    lines.push(
      `Runs: ${block.runs} | passed: ${block.passed} | failed: ${block.failed} | pending: ${block.pending ?? 0}`,
    );
  } else {
    lines.push(`passed: ${block.passed} | failed: ${block.failed}`);
  }
  if (block.failures?.length) {
    lines.push('');
    for (const f of block.failures) {
      lines.push(`- ${f.spec}`);
      lines.push(`  - ${f.test}`);
      if (f.message) lines.push(`    ${f.message}`);
      if (f.screenshot) lines.push(`    screenshot dir: ${f.screenshot}`);
      if (f.video) lines.push(`    video: ${f.video}`);
    }
  }
  return lines;
}

const meta = readJson(path.join(REPORT_DIR, 'run-meta.json'));
const jest = summarizeJest(readJson(path.join(REPORT_DIR, 'jest.json')));
const vitest = summarizeVitest(readJson(path.join(REPORT_DIR, 'vitest.json')));
const cypress = summarizeCypressRuns(path.join(REPORT_DIR, 'cypress-runs.jsonl'));

const totalFailed =
  jest.failed + vitest.failed + cypress.failed;
const totalPassed =
  jest.passed + vitest.passed + cypress.passed;
const overall = totalFailed > 0 ? 'FAILED' : 'PASSED';

const header = [
  `OpenEnroll test summary — ${new Date().toISOString()}`,
  `Suite: ${meta?.suite ?? 'unknown'}`,
  `Overall: ${overall} (${totalFailed} failed, ${totalPassed} passed)`,
  '',
];

const body = [
  ...formatSection('Backend Jest', jest),
  '',
  ...formatSection('Frontend Vitest', vitest),
  '',
  ...formatSection('Cypress', cypress),
  '',
  'Full machine-readable: test-reports/jest.json, vitest.json, cypress-runs.jsonl',
];

const text = [...header, ...body].join('\n');
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORT_DIR, 'summary.txt'), text);
fs.writeFileSync(path.join(REPORT_DIR, 'summary.md'), text);
