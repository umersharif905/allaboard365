# Training Migration Fixes (Temp 4-17)

Artifacts in this folder are user-scoped and training-scoped only.

## Files
- `01_pre_fix_snapshot.sql`: read-only snapshot of target training data before changes.
- `02_generate_undo_sql.cjs`: generates a rollback SQL file for one email, no backup tables.
- `03_fix_training_profile.sql`: transactional repair for the target profile.
- `04_post_fix_verify.sql`: post-fix verification queries.
- `05_run_training_fix.cjs`: one-command orchestrator (snapshot -> undo -> fix -> verify).

## Intended Run Order
1. Run `01_pre_fix_snapshot.sql` with target email.
2. Run `node 02_generate_undo_sql.cjs --email <target> --outdir "./"`.
3. Review generated undo file.
4. Run `03_fix_training_profile.sql` with target + baseline emails.
5. Run `04_post_fix_verify.sql` and confirm expected counts.

## One-Command Mode
- Dry run (snapshot + undo + verify only):  
  `node 05_run_training_fix.cjs --email "target@email.com" --dry-run`
- Apply run (full fix):  
  `node 05_run_training_fix.cjs --email "target@email.com"`

## Current Assumptions
- Package is `pkg-mw-001`.
- Legacy modules are `mod-0001..mod-0007` and current modules are `mod-01..mod-06`.
- Module 7 history is intentionally removed.
- Certificate metadata is copied from baseline email's latest cert for package.
