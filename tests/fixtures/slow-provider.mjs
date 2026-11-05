import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// A loopback-only, test-controlled Chat Completions provider. It makes real HTTP
// SSE responses and splits bytes across writes; no external model is contacted.
export async function createSlowProvider() {
  const requests = [], waiting = [], active = new Set();
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404); res.end(); return;
    }
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body); let content = '', publicReasoning = '', closed = false;
      if (input.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.flushHeaders(); }
      const item = {
        input, get closed() { return closed; },
        async emit(text) {
          content += text; if (closed || !input.stream) return;
          const frame = Buffer.from(`data: ${JSON.stringify({ id: 'local-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
          // Deliberately split in the middle of a UTF-8 Chinese character.
          const split = Math.max(1, frame.findIndex(byte => byte >= 0xe0) + 1);
          res.write(frame.subarray(0, split)); await delay(15);
          if (!closed) res.write(frame.subarray(split));
        },
        async emitReasoning(text) {
          publicReasoning += text; if (closed || !input.stream) return;
          res.write(`data: ${JSON.stringify({ id: 'local-fixture', choices: [{ index: 0, delta: { reasoning_content: text, signature: 'fixture-signature-must-not-render', encrypted_content: 'fixture-encrypted-must-not-render' }, finish_reason: null }] })}\n\n`);
        },
        finish() {
          if (closed) return;
          if (input.stream) {
            res.write(`data: ${JSON.stringify({ id: 'local-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
            res.end('data: [DONE]\n\n');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...(publicReasoning ? { reasoning_content: publicReasoning } : {}) }, finish_reason: 'stop' }] }));
          }
        }
      };
      active.add(res); res.once('close', () => { closed = true; active.delete(res); });
      requests.push(item); waiting.shift()?.(item);
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let consumed = 0;
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, requests,
    async nextRequest() {
      if (requests[consumed]) return requests[consumed++];
      const item = await new Promise(resolve => waiting.push(resolve)); consumed++; return item;
    },
    async close() {
      for (const response of active) response.destroy();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  };
}
