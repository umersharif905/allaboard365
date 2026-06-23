'use strict';

function wantsAiAssistantStream(req) {
  return (
    req.query?.stream === '1' ||
    req.query?.stream === 'true' ||
    String(req.headers.accept || '').includes('text/event-stream')
  );
}

/**
 * @param {import('express').Response} res
 */
function createAiAssistantSseWriter(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const write = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  return {
    delta: (text) => write({ type: 'delta', text }),
    complete: (payload) => {
      write({ type: 'complete', ...payload });
      res.end();
    },
    error: (message) => {
      write({ type: 'error', message: message || 'Assistant request failed' });
      res.end();
    },
  };
}

module.exports = {
  wantsAiAssistantStream,
  createAiAssistantSseWriter,
};
