import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = 3124;
const REQUEST_DIR = path.resolve(import.meta.dirname, '..', 'queue');
const POLL_MS = 500;
const MAX_WAIT_MS = 3_600_000; // 1 hour - we're patient

fs.mkdirSync(REQUEST_DIR, { recursive: true });

function log(...args) { console.log(`[proxy] ${new Date().toISOString()}`, ...args); }

function parseRequest(body) {
  const messages = body.messages || [];
  const userMsgs = messages.filter(m => m.role === 'user');
  const last = userMsgs[userMsgs.length - 1];
  const userText = last?.content
    ? (Array.isArray(last.content) ? last.content.map(b => b.text || '').join('\n') : String(last.content))
    : '';

  const systemText = body.system
    ? (Array.isArray(body.system) ? body.system.map(s => s.text || s).join('\n') : String(body.system))
    : '';

  return {
    requestId: randomUUID().slice(0, 12),
    userMessage: userText,
    systemPrompt: systemText,
    fullMessages: messages,
    toolCount: (body.tools || []).length,
    allTools: body.tools || [],
    model: body.model || 'unknown',
    maxTokens: body.max_tokens || 4096,
    stream: body.stream !== false,
  };
}

function writeReqFile(ctx) {
  const p = path.join(REQUEST_DIR, `request_${ctx.requestId}.json`);
  fs.writeFileSync(p, JSON.stringify(ctx, null, 2));
  log(`Request written: ${p}`);
  return ctx.requestId;
}

function writeDoneFile(id) {
  try { fs.writeFileSync(path.join(REQUEST_DIR, `response_${id}.done`), ''); } catch {}
}

function cleanup(id) {
  try { fs.unlinkSync(path.join(REQUEST_DIR, `request_${id}.json`)); } catch {}
  try { fs.unlinkSync(path.join(REQUEST_DIR, `response_${id}.ndjson`)); } catch {}
  try { fs.unlinkSync(path.join(REQUEST_DIR, `response_${id}.done`)); } catch {}
}

function buildEvents(contentBlocks, stopReason, inputTokens, outputTokens) {
  const events = [];
  const msgId = `msg_${randomUUID().slice(0, 8)}`;

  events.push({ event: 'message_start', data: {
    type: 'message_start',
    message: { id: msgId, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } },
  }});

  for (let i = 0; i < contentBlocks.length; i++) {
    const blk = contentBlocks[i];
    const startBlock = { ...blk };
    if (blk.type === 'text') startBlock.text = '';
    if (blk.type === 'tool_use') startBlock.input = {};

    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: i, content_block: startBlock } });

    if (blk.type === 'text' && blk.text) {
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: blk.text } } });
    }
    if (blk.type === 'tool_use' && blk.input) {
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(blk.input) } } });
    }

    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: i } });
  }

  events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } } });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}

function respondToRequest(requestId, contentBlocks, stopReason = 'end_turn') {
  const events = buildEvents(contentBlocks, stopReason, 10, 20);
  const ndjson = events.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(REQUEST_DIR, `response_${requestId}.ndjson`), ndjson + '\n');
  writeDoneFile(requestId);
  log(`Response written for ${requestId}`);
  return events;
}

function handleRequest(req, res) {
  let rawBody = '';
  req.on('data', chunk => { rawBody += chunk; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(rawBody); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Bad JSON: ${e.message}` } }));
    }

    const ctx = parseRequest(parsed);
    const id = writeReqFile(ctx);
    const isStreaming = parsed.stream !== false;

    log(`Request ${id}: model=${ctx.model} msg="${ctx.userMessage.slice(0, 60)}" stream=${isStreaming} tools=${ctx.toolCount}`);

    if (isStreaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'x-request-id': id,
      });

      const pollTimer = setInterval(() => {
        const ndjsonPath = path.join(REQUEST_DIR, `response_${id}.ndjson`);
        const donePath = path.join(REQUEST_DIR, `response_${id}.done`);
        const doneExists = fs.existsSync(donePath);

        if (fs.existsSync(ndjsonPath)) {
          try {
            const content = fs.readFileSync(ndjsonPath, 'utf8').trim();
            if (content) {
              for (const line of content.split('\n')) {
                try {
                  const { event, data } = JSON.parse(line);
                  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                } catch {}
              }
            }
            fs.truncateSync(ndjsonPath, 0);
          } catch {}
        }

        if (doneExists) {
          clearInterval(pollTimer);
          try { fs.unlinkSync(donePath); } catch {}
          try { fs.unlinkSync(ndjsonPath); } catch {}
          log(`Streaming completed for ${id}`);
          res.end();
        }
      }, POLL_MS);

      req.on('close', () => {
        clearInterval(pollTimer);
        log(`Client disconnected for ${id}`);
      });
    } else {
      const pollTimer = setInterval(() => {
        const ndjsonPath = path.join(REQUEST_DIR, `response_${id}.ndjson`);
        const donePath = path.join(REQUEST_DIR, `response_${id}.done`);

        if (fs.existsSync(ndjsonPath) && fs.existsSync(donePath)) {
          clearInterval(pollTimer);
          try {
            const content = fs.readFileSync(ndjsonPath, 'utf8').trim();
            const lines = content ? content.split('\n') : [];

            // Reconstruct blocks from events
            let contentBlocks = [];
            let stopReason = 'end_turn';
            for (const raw of lines) {
              try {
                const { event: ev, data: d } = JSON.parse(raw);
                if (ev === 'content_block_start' && d.content_block) {
                  contentBlocks[d.index] = { ...d.content_block };
                } else if (ev === 'content_block_delta' && d.delta) {
                  const blk = contentBlocks[d.index];
                  if (blk) {
                    if (d.delta.text) blk.text = (blk.text || '') + d.delta.text;
                    if (d.delta.partial_json) { try { blk.input = JSON.parse(d.delta.partial_json); } catch {} }
                  }
                } else if (ev === 'message_delta' && d.delta) {
                  stopReason = d.delta.stop_reason || stopReason;
                }
              } catch {}
            }

            const inputTokens = 10, outputTokens = 20;
            const msgId = `msg_${randomUUID().slice(0, 8)}`;
            const resp = {
              id: msgId, type: 'message', role: 'assistant',
              content: contentBlocks,
              model: ctx.model,
              stop_reason: stopReason,
              stop_sequence: null,
              usage: { input_tokens: inputTokens, output_tokens: outputTokens },
            };

            res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': id });
            res.end(JSON.stringify(resp));
            cleanup(id);
            log(`Non-streaming response sent for ${id}`);
          } catch (e) {
            log(`Error sending response: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'server_error', message: e.message } }));
          }
        }
      }, POLL_MS);

      req.on('close', () => { clearInterval(pollTimer); });
    }
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mode: 'opencode-bridge', pid: process.pid }));
    return;
  }

  if (req.method === 'GET' && req.url === '/queue') {
    try {
      const files = fs.readdirSync(REQUEST_DIR);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/messages') {
    handleRequest(req, res);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  log(`opencode bridge listening on http://127.0.0.1:${PORT}`);
  log(`Queue directory: ${REQUEST_DIR}`);
});
