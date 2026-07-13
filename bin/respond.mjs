#!/usr/bin/env node
// respond.mjs <request-id> [--text "<text>"] [--tool <name> <input-json>] [--stop <stop-reason>]
//
// Generates Anthropic SSE response events for the opencode bridge.
// Used by opencode to respond to CLI requests through the proxy.
//
// Usage:
//   node respond.mjs abc123 --text "Hello world"
//   node respond.mjs abc123 --text "Running..." --tool Bash '{"command":"ls"}'
//   node respond.mjs abc123 --tool Bash '{"command":"ls"}' --stop tool_use

import fs from 'node:fs';
import path from 'node:path';

const REQUEST_DIR = path.resolve(import.meta.dirname, '..', 'queue');

function usage() {
  console.error(`Usage: node respond.mjs <request-id> [options]
Options:
  --text "<text>"          Text content block(s) to include
  --tool <name> <json>     Tool use block (name, then JSON input as string)
  --stop <reason>          Stop reason: end_turn | tool_use | etc (default: end_turn)
  --clean                  Remove the request file after responding
  --input-tokens <n>       Estimated input tokens (default: 10)
  --output-tokens <n>      Estimated output tokens (default: 10)

Examples:
  node respond.mjs abc123 --text "Hello!"
  node respond.mjs abc123 --text "Checking..." --tool Bash '{"command":"ls -la"}'
  node respond.mjs abc123 --text "Done" --text "More text" --stop end_turn --clean`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 1) usage();

const requestId = args[0];
const inputTokens = 10;
const outputTokens = 10;

const blocks = [];
let stopReason = 'end_turn';
let clean = false;

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case '--text': {
      i++;
      const text = args[i];
      if (text === undefined) usage();
      blocks.push({ type: 'text', text });
      break;
    }
    case '--tool': {
      i++;
      const name = args[i];
      i++;
      const input = args[i];
      if (name === undefined || input === undefined) usage();
      const toolId = `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      let parsed;
      try { parsed = JSON.parse(input); } catch { parsed = { raw: input }; }
      blocks.push({ type: 'tool_use', id: toolId, name, input: parsed });
      break;
    }
    case '--stop': {
      i++;
      stopReason = args[i];
      if (stopReason === undefined) usage();
      break;
    }
    case '--clean':
      clean = true;
      break;
    case '--input-tokens':
      i++; inputTokens = parseInt(args[i]); break;
    case '--output-tokens':
      i++; outputTokens = parseInt(args[i]); break;
    default:
      usage();
  }
}

const responsePath = path.join(REQUEST_DIR, `response_${requestId}.ndjson`);
const donePath = path.join(REQUEST_DIR, `response_${requestId}.done`);
const requestPath = path.join(REQUEST_DIR, `request_${requestId}.json`);

if (!fs.existsSync(requestPath)) {
  console.error(`[respond] Warning: request ${requestId} not found at ${requestPath}`);
  console.error('[respond] Proceeding anyway...');
}

const events = [];
const msgId = `msg_${requestId}`;

events.push({ event: 'message_start', data: {
  type: 'message_start',
  message: { id: msgId, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } },
}});

for (let i = 0; i < blocks.length; i++) {
  const block = blocks[i];
  const startBlock = { ...block };
  if (block.type === 'text') startBlock.text = '';
  if (block.type === 'tool_use') startBlock.input = {};

  events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: i, content_block: startBlock } });

  if (block.type === 'text' && block.text) {
    events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } } });
  }

  if (block.type === 'tool_use' && block.input) {
    events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } } });
  }

  events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: i } });
}

events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } } });
events.push({ event: 'message_stop', data: { type: 'message_stop' } });

const ndjson = events.map(e => JSON.stringify(e)).join('\n');
fs.writeFileSync(responsePath, ndjson + '\n');
fs.writeFileSync(donePath, '');

console.log(`[respond] Sent ${blocks.length} block(s) for request ${requestId} (stop: ${stopReason})`);
console.log(`[respond] Events written to: ${responsePath}`);

if (clean && fs.existsSync(requestPath)) {
  fs.unlinkSync(requestPath);
  console.log(`[respond] Cleaned up request file: ${requestPath}`);
}
