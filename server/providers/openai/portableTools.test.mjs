// OpenAI function-parameter schemas reject `\p{..}` Unicode-property classes
// in `pattern` ("is not a 'regex'", 400 invalid_function_parameters). One such
// pattern, resolve_area.candidateId, made every OpenAI Realtime mint and every
// OpenAI text chat fail. These tests pin the contract of the fix: OpenAI gets a
// portable COPY of the tool schemas; the shared schema (Gemini, local
// validation) keeps the strict grammar.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import * as toolsModule from './tools.js';
import { GEV_REALTIME_TOOLS, offeredTools } from './tools.js';
import { createRealtimeTokenHandler } from './realtime.js';
import { createOpenAiChatHandler } from './chat.js';
import { createGeminiChatHandler } from '../gemini/chat.js';
import { createGeminiLiveConfig } from '../gemini/config.js';
import {
  AREA_CANDIDATE_ID_PATTERN,
  isAreaCandidateId,
} from '../../../src/voice/areaCandidateContract.js';
import { validateValue } from '../../../src/tools/schema.js';

// A `\p` / `\P` escape that is not itself escaped (an odd run of backslashes).
const UNICODE_PROPERTY_ESCAPE = /(?<!\\)(?:\\\\)*\\[pP]/;

/** Every string stored under a `pattern` key anywhere in a JSON value. */
function patternsIn(node, out = []) {
  if (Array.isArray(node)) node.forEach((item) => patternsIn(item, out));
  else if (node && typeof node === 'object')
    for (const [key, value] of Object.entries(node))
      key === 'pattern' && typeof value === 'string'
        ? out.push(value)
        : patternsIn(value, out);
  return out;
}

const snapshot = (value) => JSON.stringify(value);
const resolveArea = (tools) => tools.find((tool) => tool.name === 'resolve_area');
const portable = (tools) => toolsModule.openAiPortableTools(tools);

async function mintSessionTools({ overpass }) {
  let sent;
  const handler = createRealtimeTokenHandler({
    resolveApiKey: () => 'fixture-only',
    environment: {},
    overpassConfigured: () => overpass,
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response('{"value":"x"}', { status: 200 });
    },
  });
  const headers = {};
  const res = {
    setHeader: (name, value) => (headers[name] = value),
    end() {},
  };
  await handler(
    { method: 'GET', url: '/api/realtime/token?tier=mini', headers: {}, socket: {} },
    res,
  );
  assert.equal(res.statusCode, 200);
  return sent.session.tools;
}

async function chatFixture(t, { reply, overpass = true } = {}) {
  const calls = [];
  const handler = createOpenAiChatHandler({
    resolveApiKey: () => 'fixture-only',
    resolveRateLimit: () => '0',
    resolveHost: () => '',
    resolveAllowedHosts: () => '',
    environment: {},
    overpassConfigured: () => overpass,
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return Response.json(reply);
    },
  });
  const server = http.createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    send: () =>
      fetch(origin, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
      }),
  };
}

const resolveAreaReply = (candidateId) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            type: 'function',
            id: 'call-1',
            function: { name: 'resolve_area', arguments: JSON.stringify({ candidateId }) },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
});

test('the shared resolve_area schema keeps the strict Unicode grammar (premise)', () => {
  const shared = resolveArea(GEV_REALTIME_TOOLS).parameters.properties.candidateId;
  assert.equal(shared.pattern, AREA_CANDIDATE_ID_PATTERN);
  assert.match(shared.pattern, UNICODE_PROPERTY_ESCAPE);
});

test('realtime session tools sent to OpenAI carry no Unicode-property pattern', async () => {
  for (const overpass of [false, true]) {
    const tools = await mintSessionTools({ overpass });
    assert.equal(tools.length, offeredTools(GEV_REALTIME_TOOLS, { overpass }).length);
    for (const pattern of patternsIn(tools))
      assert.doesNotMatch(pattern, UNICODE_PROPERTY_ESCAPE, `OpenAI rejects: ${pattern}`);
  }
});

test('OpenAI chat tools sent to OpenAI carry no Unicode-property pattern', async (t) => {
  for (const overpass of [false, true]) {
    const f = await chatFixture(t, { reply: resolveAreaReply('ne:country:ok'), overpass });
    assert.equal((await f.send()).status, 200);
    const { tools } = f.calls[0];
    assert.equal(tools.length, offeredTools(GEV_REALTIME_TOOLS, { overpass }).length);
    for (const pattern of patternsIn(tools))
      assert.doesNotMatch(pattern, UNICODE_PROPERTY_ESCAPE, `OpenAI rejects: ${pattern}`);
  }
});

test('the OpenAI copy differs from the shared schema only by that one pattern', async (t) => {
  const offered = offeredTools(GEV_REALTIME_TOOLS, { overpass: true });
  const expected = structuredClone(offered);
  delete resolveArea(expected).parameters.properties.candidateId.pattern;

  assert.deepEqual(await mintSessionTools({ overpass: true }), expected);

  const f = await chatFixture(t, { reply: resolveAreaReply('ne:country:ok') });
  await f.send();
  assert.deepEqual(
    f.calls[0].tools,
    expected.map(({ name, description, parameters }) => ({
      type: 'function',
      function: { name, description, parameters, strict: false },
    })),
  );
});

test('adapting for OpenAI copies: the shared tool schemas are not mutated', async () => {
  const before = snapshot(GEV_REALTIME_TOOLS);
  const adapted = portable(GEV_REALTIME_TOOLS);
  assert.equal(snapshot(GEV_REALTIME_TOOLS), before);
  assert.notEqual(adapted, GEV_REALTIME_TOOLS);
  assert.equal(
    resolveArea(GEV_REALTIME_TOOLS).parameters.properties.candidateId.pattern,
    AREA_CANDIDATE_ID_PATTERN,
  );
  assert.equal(
    'pattern' in resolveArea(adapted).parameters.properties.candidateId,
    false,
  );
  // Mutating the copy cannot reach the shared schema either.
  resolveArea(adapted).parameters.properties.query.maxLength = 1;
  assert.notEqual(resolveArea(GEV_REALTIME_TOOLS).parameters.properties.query.maxLength, 1);
  // Serving the mint/chat endpoints leaves the shared tools untouched too.
  await mintSessionTools({ overpass: true });
  assert.equal(snapshot(GEV_REALTIME_TOOLS), before);
});

test('Gemini still receives the strict candidate pattern, chat and live', async (t) => {
  const geminiBodies = [];
  const handler = createGeminiChatHandler({
    resolveApiKey: () => 'fixture-only',
    resolveRateLimit: () => '0',
    resolveHost: () => '',
    resolveAllowedHosts: () => '',
    environment: {},
    overpassConfigured: () => true,
    fetchImpl: async (_url, options) => {
      geminiBodies.push(JSON.parse(options.body));
      return Response.json({
        candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    },
  });
  const server = http.createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] }),
  });
  assert.equal(response.status, 200);
  const chatDeclarations = geminiBodies[0].tools[0].functionDeclarations;
  const live = createGeminiLiveConfig('', 'open-mic', GEV_REALTIME_TOOLS, { overpass: true });
  for (const declarations of [chatDeclarations, live.tools[0].functionDeclarations]) {
    assert.equal(
      resolveArea(declarations).parametersJsonSchema.properties.candidateId.pattern,
      AREA_CANDIDATE_ID_PATTERN,
    );
  }
});

test('the adapter strips only schema `pattern` fields that use \\p / \\P', () => {
  const source = [
    {
      type: 'function',
      name: 'probe',
      description: 'Mentions \\p{L} in prose; must stay.',
      parameters: {
        type: 'object',
        description: 'pattern \\p{L}',
        properties: {
          // A property NAMED pattern is a schema, not a pattern string.
          pattern: { type: 'string', enum: ['grid', '\\p{L}+'], default: '\\p{L}' },
          ascii: { type: 'string', pattern: '\\S' },
          escaped: { type: 'string', pattern: '^\\\\pdf$' },
          unicode: { type: 'string', pattern: '^[\\p{L}]+$', description: 'keeps this' },
          negated: { type: 'string', pattern: '^\\P{L}$' },
          list: {
            type: 'array',
            items: { type: 'string', pattern: '\\p{N}+', maxLength: 5 },
          },
          nested: {
            type: 'object',
            properties: { deep: { type: 'string', pattern: '\\p{M}' } },
          },
        },
      },
    },
  ];
  const before = snapshot(source);
  const [tool] = portable(source);
  const { properties } = tool.parameters;
  assert.equal(snapshot(source), before);

  assert.equal(tool.description, source[0].description);
  assert.equal(tool.parameters.description, 'pattern \\p{L}');
  assert.deepEqual(properties.pattern, source[0].parameters.properties.pattern);
  assert.equal(properties.ascii.pattern, '\\S');
  assert.equal(properties.escaped.pattern, '^\\\\pdf$');
  assert.equal('pattern' in properties.unicode, false);
  assert.equal(properties.unicode.description, 'keeps this');
  assert.equal('pattern' in properties.negated, false);
  assert.equal('pattern' in properties.list.items, false);
  assert.equal(properties.list.items.maxLength, 5);
  assert.equal('pattern' in properties.nested.properties.deep, false);
});

test('local validation stays strict: Unicode ids pass, malformed ids are rejected', async (t) => {
  for (const ok of [
    'ne:country:côte-d-ivoire',
    'ne:country:co\u0302te-d-ivoire',
    'ne:state:北京',
    'ne:natural:rocky-mountains',
  ]) {
    assert.equal(isAreaCandidateId(ok), true, ok);
    assert.deepEqual(
      validateValue(resolveArea(GEV_REALTIME_TOOLS).parameters, { candidateId: ok }),
      [],
      ok,
    );
  }
  for (const bad of [
    'ne:country:bad id',
    'ne:country:',
    'ne:country:a--b',
    'ne:country:a_b',
    'ne:river:nile',
    `ne:state:${'x'.repeat(80)}`,
  ]) {
    assert.equal(isAreaCandidateId(bad), false, bad);
    assert.notDeepEqual(
      validateValue(resolveArea(GEV_REALTIME_TOOLS).parameters, { candidateId: bad }),
      [],
      bad,
    );
  }

  // Through the live OpenAI chat route, whose OpenAI-bound copy has no
  // pattern: the model's call is still checked against the strict schema.
  const rejected = await chatFixture(t, { reply: resolveAreaReply('ne:country:bad id') });
  const rejectedBody = await (await rejected.send()).json();
  assert.equal(rejectedBody.invalidCalls.length, 1);
  assert.match(rejectedBody.invalidCalls[0].error, /candidateId must match/);

  const accepted = await chatFixture(t, { reply: resolveAreaReply('ne:country:côte-d-ivoire') });
  const acceptedBody = await (await accepted.send()).json();
  assert.deepEqual(acceptedBody.invalidCalls, []);
});

test('tool names and descriptions reach OpenAI unchanged', async () => {
  const offered = offeredTools(GEV_REALTIME_TOOLS, { overpass: true });
  const sent = await mintSessionTools({ overpass: true });
  assert.deepEqual(
    sent.map(({ name, description }) => ({ name, description })),
    offered.map(({ name, description }) => ({ name, description })),
  );
  const descriptions = (node, out = []) => {
    if (Array.isArray(node)) node.forEach((item) => descriptions(item, out));
    else if (node && typeof node === 'object')
      for (const [key, value] of Object.entries(node))
        key === 'description' && typeof value === 'string'
          ? out.push(value)
          : descriptions(value, out);
    return out;
  };
  assert.deepEqual(descriptions(sent), descriptions(offered));
  assert.ok(descriptions(offered).length > 0);
});
