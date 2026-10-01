import { withRetry, retryable, isRetryableStatus, isAbort, abortedError } from './retry.js';
const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function toAnthropicMessages(history) {
  const out = [];
  for (const m of history) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls || []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      if (content.length) out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: (m.results || []).map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: typeof r.output === 'string' ? r.output : String(r.output ?? ''),
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return out;
}

/**
 * JOB AG-1 — a streamed Messages response, rebuilt into the object the
 * non-streamed call returns ({content, stop_reason, usage}), so the parsing
 * below is the same code either way. Text deltas go to `onStream` as they
 * arrive; tool input arrives as JSON fragments and is parsed once complete.
 */
async function readMessageStream(res, { onStream, signal }) {
  const blocks = [];
  const partialJson = [];
  let stopReason = null;
  const usage = {};

  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    let ev;
    try { ev = JSON.parse(line.slice(5).trim()); } catch { return; }
    switch (ev.type) {
      case 'message_start':
        Object.assign(usage, ev.message?.usage || {});
        break;
      case 'content_block_start':
        blocks[ev.index] = { ...ev.content_block };
        if (blocks[ev.index].type === 'text') blocks[ev.index].text = blocks[ev.index].text || '';
        partialJson[ev.index] = '';
        break;
      case 'content_block_delta': {
        const b = blocks[ev.index];
        if (!b) break;
        if (ev.delta?.type === 'text_delta') {
          b.text += ev.delta.text;
          onStream({ type: 'text', text: ev.delta.text });
        } else if (ev.delta?.type === 'input_json_delta') {
          partialJson[ev.index] += ev.delta.partial_json || '';
        }
        break;
      }
      case 'content_block_stop': {
        const b = blocks[ev.index];
        if (b?.type === 'tool_use' && partialJson[ev.index]) {
          try { b.input = JSON.parse(partialJson[ev.index]); } catch { b.input = {}; }
        }
        break;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        Object.assign(usage, ev.usage || {});
        break;
      case 'error': {
        const e = new Error(ev.error?.message || 'Anthropic reported an error mid-stream');
        e.fromStream = true;
        // Overloaded and API errors are the upstream's; anything else is ours.
        if (['overloaded_error', 'api_error'].includes(ev.error?.type)) e.retryable = true;
        throw e;
      }
      default:
        break;
    }
  };

  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const part of res.body) {
      buf += decoder.decode(part, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        handle(line);
      }
    }
    if (buf.trim()) handle(buf.trim());
  } catch (err) {
    if (isAbort(err, signal)) throw abortedError('the Anthropic request');
    if (err.fromStream) throw err;
    throw retryable(new Error(`Anthropic stream broke off: ${err.message}`));
  }
  return { content: blocks.filter(Boolean), stop_reason: stopReason, usage };
}

export async function chat({ apiKey, model, system, history, tools, maxTokens = 4096, decoding, signal = null, onStream = null }) {
  const streaming = typeof onStream === 'function';
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: toAnthropicMessages(history),
    ...(streaming ? { stream: true } : {}),
  };
  // A1 passthrough. This API has a temperature and no seed, so the seed is
  // dropped here rather than silently pretended at — `DECODING_SENT` records
  // that, so a caller can report what it actually got.
  if (decoding?.temperature !== undefined) body.temperature = decoding.temperature;
  if (tools?.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }
  // Same bounded retry as the OpenAI-compatible adapter: a 5xx, a 429 or a
  // dropped connection gets another attempt; a 4xx does not, because that is
  // our own request being wrong. See ./retry.js for the measurement.
  const payload = JSON.stringify(body);
  const data = await withRetry('anthropic chat', async () => {
    // A retry must not append to what a failed attempt already showed.
    if (streaming) onStream({ type: 'start' });
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: payload,
        // Phase 0. The model call is a read: aborting it in flight costs
        // nothing and leaves nothing half-written, which is what makes it the
        // one thing in a turn that IS safe to interrupt.
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // Checked before the unreachable branch, which marks its error retryable
      // — a cancelled request answered with three more requests is the opposite
      // of cancelling it.
      if (isAbort(err, signal)) throw abortedError('the Anthropic request');
      throw retryable(new Error(`Anthropic unreachable: ${err.message}`));
    }
    if (!res.ok) {
      const parsed = await res.json().catch(() => null);
      const e = new Error(parsed?.error?.message || `Anthropic API error (${res.status})`);
      e.status = res.status;
      if (isRetryableStatus(res.status)) e.retryable = true;
      throw e;
    }
    return streaming ? readMessageStream(res, { onStream, signal }) : res.json().catch(() => null);
  });
  let text = '';
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }
  return { text, toolCalls, stopReason: data.stop_reason };
}

export const anthropicDefaults = { model: DEFAULT_MODEL };
