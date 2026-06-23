# Test reports

After `./run-tests.sh` (or any suite that runs tests), read **`summary.txt`** here — failures only, no full Cypress console log.

| File | Contents |
|------|----------|
| `summary.txt` | Human-readable rollup (paste this for debugging / AI) |
| `summary.md` | Same content, markdown |
| `jest.json` | Last backend Jest run (machine-readable) |
| `vitest.json` | Last frontend Vitest run |
| `cypress-runs.jsonl` | One JSON line per Cypress `cypress run` (enrollment loop = multiple lines) |
| `run-meta.json` | Suite name + start time |

Artifacts (videos/screenshots) stay under `frontend/cypress/` — the summary links to paths when Cypress failed.
