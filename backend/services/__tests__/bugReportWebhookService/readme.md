# Summary
We run several tests here; most are just inert but there's a few that are live tests so that we can tweak the functionality without building a UX

# how to run inert tests from repo root
npm test --prefix backend -- --testPathPattern=bugReportWebhookService -t "POSTs context and payload"

# how to run live test from repo root
npm run test:live --prefix backend -- -t "createRealBugReport"

# how to view automations in cursor
https://cursor.com/automations
https://cursor.com/automations/runs