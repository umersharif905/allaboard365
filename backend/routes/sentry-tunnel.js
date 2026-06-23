const express = require('express');
const dns = require('dns');
const { Agent, fetch: undiciFetch } = require('undici');
const router = express.Router();

// Forwards Sentry envelopes from the browser to Sentry's ingest API.
// Purpose: bypass DNS hijacking / ad-blockers that block *.ingest.sentry.io,
// which manifests as ERR_CONNECTION_RESET in the browser.
// https://docs.sentry.io/platforms/javascript/troubleshooting/#using-the-tunnel-option
//
// Some ISPs (observed: Turk Telekom) hijack DNS for sentry.io ingest domains
// and return a sinkhole IP. We use a dedicated resolver pointed at public DNS
// so the tunnel works regardless of the host machine's /etc/resolv.conf.

const ALLOWED_HOSTS = new Set(['o4511259885305856.ingest.us.sentry.io']);
const ALLOWED_PROJECTS = new Set(['4511265712766976', '4511265725284352']);

const resolver = new dns.promises.Resolver();
resolver.setServers(['1.1.1.1', '8.8.8.8']);

const sentryDispatcher = new Agent({
    connect: {
        lookup: (hostname, options, cb) => {
            resolver.resolve4(hostname).then(
                (addrs) => {
                    if (options && options.all) {
                        cb(null, addrs.map((a) => ({ address: a, family: 4 })));
                    } else {
                        cb(null, addrs[0], 4);
                    }
                },
                (err) => cb(err),
            );
        },
    },
});

router.post('/', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
    try {
        const envelope = req.body;
        if (typeof envelope !== 'string' || !envelope) {
            return res.status(400).json({ success: false, message: 'Empty envelope' });
        }

        const firstNewline = envelope.indexOf('\n');
        if (firstNewline === -1) {
            return res.status(400).json({ success: false, message: 'Malformed envelope' });
        }

        const header = JSON.parse(envelope.slice(0, firstNewline));
        const dsn = new URL(header.dsn);
        const host = dsn.host;
        const projectId = dsn.pathname.replace(/^\//, '');

        if (!ALLOWED_HOSTS.has(host) || !ALLOWED_PROJECTS.has(projectId)) {
            return res.status(403).json({ success: false, message: 'DSN not allowed' });
        }

        const upstream = await undiciFetch(`https://${host}/api/${projectId}/envelope/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-sentry-envelope' },
            body: envelope,
            dispatcher: sentryDispatcher,
        });

        res.status(upstream.status).send(await upstream.text());
    } catch (err) {
        console.error('❌ Sentry tunnel error:', err);
        res.status(500).json({
            success: false,
            message: 'Tunnel forward failed',
            error: err?.message,
            type: err?.constructor?.name,
        });
    }
});

module.exports = router;
