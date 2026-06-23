let serviceBus = null;

const SEND_TIMEOUT_MS = parseInt(process.env.SERVICE_BUS_SEND_TIMEOUT_MS || '15000', 10);

const getClient = () => {
  if (serviceBus) return serviceBus;
  const { ServiceBusClient } = require('@azure/service-bus');
  const conn = process.env.SERVICE_BUS_CONNECTION;
  if (!conn) throw new Error('SERVICE_BUS_CONNECTION env var not set');
  // Tight retry budget so the sender doesn't sit re-trying for ~60s on a stalled
  // connection — extraction enqueue must be fire-and-forget-fast from the API hot path.
  serviceBus = new ServiceBusClient(conn, {
    retryOptions: { maxRetries: 1, retryDelayInMs: 500, timeoutInMs: SEND_TIMEOUT_MS },
  });
  return serviceBus;
};

// Reset the cached client (e.g. after a hung send) so the next call recreates it.
function resetClient() {
  try { if (serviceBus) serviceBus.close(); } catch (_) { /* ignore */ }
  serviceBus = null;
}

async function enqueueExtraction(message) {
  if (process.env.AI_EXTRACTION_DISABLED === '1') {
    console.warn('[extractionQueue] disabled by env, skipping enqueue:', message);
    return;
  }
  const sender = getClient().createSender('ai-extract-queue');
  try {
    // Race the SB send against a hard timeout so a stalled namespace can't pin our hot path.
    await Promise.race([
      sender.sendMessages({ body: message }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Service Bus send timed out after ' + SEND_TIMEOUT_MS + 'ms')), SEND_TIMEOUT_MS)),
    ]);
  } finally {
    // Close in the background — don't block the caller on sender teardown.
    sender.close().catch(() => {});
  }
}

module.exports = { enqueueExtraction, resetClient };
