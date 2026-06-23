// backend/scripts/run-website-form-digest.js
//
// CLI shim to run the website form digest locally without going through HTTP.
// Useful for testing the email rendering or kicking off a manual run.
//
// Usage:
//   node backend/scripts/run-website-form-digest.js            # send for real, last 7 days
//   node backend/scripts/run-website-form-digest.js --dry-run  # don't send, just log
//   node backend/scripts/run-website-form-digest.js --hours 24  # override to a 24h window

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { runWebsiteFormDigest } = require('../jobs/websiteFormDigest');

(async () => {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const hoursIdx = args.indexOf('--hours');
    const windowHours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : 168;

    console.log(`Running digest (windowHours=${windowHours}, dryRun=${dryRun})...`);
    try {
        const stats = await runWebsiteFormDigest({ windowHours, dryRun });
        console.log('Stats:', JSON.stringify(stats, null, 2));
        process.exit(0);
    } catch (err) {
        console.error('Failed:', err);
        process.exit(1);
    }
})();
