// Quick CORS test script
const { buildCorsMiddleware } = require('./backend/middleware/cors');

// Set test environment variable
process.env.ALLOWED_ORIGINS = '*.allaboard365.com';

// Build options
const opts = buildCorsMiddleware();

console.log('\n=== CORS Wildcard Test Suite ===\n');

const tests = [
    ['app.allaboard365.com', true, 'Exact match (static list)'],
    ['portal.allaboard365.com', true, 'Exact match (static list)'],
    ['tenant123.allaboard365.com', true, 'Wildcard match'],
    ['foo.bar.allaboard365.com', true, 'Multi-level wildcard match'],
    ['malicious.com', false, 'Should be blocked'],
    ['evil.allaboard365.com.evil.com', false, 'Should be blocked (tricky domain)']
];

let completed = 0;

tests.forEach(([domain, expected, description]) => {
    const origin = `https://${domain}`;
    opts.origin(origin, (err, allow) => {
        const passed = allow === expected;
        const status = passed ? '✅' : '❌';
        console.log(`${status} ${domain.padEnd(30)} ${description}`);
        if (!passed) {
            console.log(`   Expected: ${expected ? 'ALLOW' : 'BLOCK'}, Got: ${allow ? 'ALLOW' : 'BLOCK'}`);
        }
        
        completed++;
        if (completed === tests.length) {
            console.log('\n✅ All tests complete!\n');
            process.exit(0);
        }
    });
});

// Timeout fallback
setTimeout(() => {
    console.log('\n⏱️  Tests timed out\n');
    process.exit(1);
}, 2000);

