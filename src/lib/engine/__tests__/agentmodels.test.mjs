// How agent jobs call the providers (src/server/agent/models.ts, runner.ts): the reasoning effort
// for people's own keys, and look screenshots inside tool results. Checked on the requests the
// AI SDK's providers would send (a fake fetch captures them; no network).
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { jsonSchema, streamText, tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

register('./resolve-hooks.mjs', import.meta.url);

const { reasoningFor } = await import('../../../server/agent/models.ts');
const { attachLookImages, resolveLookImages } = await import('../../../server/agent/look.ts');

describe('reasoning effort', () => {
  test('Anthropic and OpenAI keys run at high effort unless people choose another level; Orb\'s AI at low; others keep the default', () => {
    assert.equal(reasoningFor('anthropic', {}), 'high');
    assert.equal(reasoningFor('openai', { effort: 'xhigh' }), 'xhigh');
    assert.equal(reasoningFor('anthropic', { effort: 'medium' }), 'medium');
    assert.equal(reasoningFor('openai', { effort: 'low' }), 'low');
    assert.equal(reasoningFor('anthropic', { effort: 'max!!' }), 'high');
    for (const p of ['openrouter', 'mock', 'cursor']) assert.equal(reasoningFor(p, { effort: 'low' }), undefined);
    assert.equal(reasoningFor('free', { effort: 'high' }), 'low', "Orb's AI thinks little, whatever was asked");
  });
});

/** The body of the first request a model makes (the fake provider then fails, ending the call). */
async function requestBody(makeModel, opts) {
  let body = null;
  const fetch = async (_url, init) => {
    body ??= JSON.parse(init.body);
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'stop here' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  const result = streamText({ model: makeModel(fetch), maxRetries: 0, ...opts });
  try {
    for await (const part of result.fullStream) if (part.type === 'error') break;
  } catch {
    /* the fake provider refuses */
  }
  return body;
}

/** A conversation that just played the world: the look's result carries a screenshot. */
async function afterALook() {
  const steps = attachLookImages(
    [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'look', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'look', output: { type: 'text', value: 'Frame rate: 60 fps.' } }] },
    ],
    new Map([['call_1', [{ ref: 'orb-look:LOOK0001:0', mediaType: 'image/webp', label: 'end' }]]]),
    'tool',
  );
  const db = { query: async () => [{ result: { shots: [{ label: 'end', t: 1, dataUrl: 'data:image/webp;base64,UklGRiQAAABXRUJQ' }] } }] };
  return resolveLookImages(db, 'job', [{ role: 'user', content: 'a garden' }, ...steps], new Map());
}

const tools = { look: tool({ description: 'look', inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => '' }) };

describe('provider requests', () => {
  test('Anthropic: adaptive thinking with summaries at high effort, 64K output, the screenshot in the tool result', async () => {
    const body = await requestBody((fetch) => createAnthropic({ apiKey: 'sk-ant-test', fetch })('claude-opus-5-5'), {
      messages: await afterALook(),
      tools,
      reasoning: reasoningFor('anthropic', {}),
      maxOutputTokens: 64_000,
    });
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal(body.output_config?.effort, 'high');
    assert.equal(body.max_tokens, 64_000);
    const result = body.messages[2].content.find((c) => c.type === 'tool_result');
    assert.equal(result.tool_use_id, 'call_1');
    assert.deepEqual(result.content, [
      { type: 'text', text: 'Frame rate: 60 fps.' },
      { type: 'text', text: 'Screenshot "end":' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRiQAAABXRUJQ' } },
    ]);
  });

  test('OpenAI: reasoning effort, and the screenshot as an input image of the function output', async () => {
    const body = await requestBody((fetch) => createOpenAI({ apiKey: 'sk-test', fetch })('gpt-6.1-sol'), {
      messages: await afterALook(),
      tools,
      reasoning: reasoningFor('openai', { effort: 'xhigh' }),
      maxOutputTokens: 64_000,
    });
    assert.equal(body.reasoning?.effort, 'xhigh');
    const out = body.input.find((i) => i.type === 'function_call_output');
    assert.equal(out.call_id, 'call_1');
    assert.ok(out.output.some((o) => o.type === 'input_image' && o.image_url === 'data:image/webp;base64,UklGRiQAAABXRUJQ'), JSON.stringify(out.output));
  });
});
