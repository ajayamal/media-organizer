import assert from 'node:assert/strict';
import test from 'node:test';
import { LmStudioClient } from '../src/services/lm-studio.js';
import { parseMediaPath } from '../src/services/metadata-matching.js';

test('requests title suggestions from the configured OpenAI-compatible endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestBody: Record<string, unknown> | undefined;
  let authorization = '';
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    authorization = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"titles":["Example","Example", "../invalid"]}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new LmStudioClient('http://127.0.0.1:1234/v1/', 'test-model', 'test-token');
    const parsed = parseMediaPath('movies/Movies/Mysterious Film (2020)/movie.mkv', 'movies/Movies');
    const titles = await client.suggestSearchTitles('movies/Movies/Mysterious Film (2020)/movie.mkv', parsed);
    assert.equal(requestUrl, 'http://127.0.0.1:1234/v1/chat/completions');
    assert.equal(requestBody?.model, 'test-model');
    assert.equal(authorization, 'Bearer test-token');
    assert.deepEqual(titles, ['Example']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects invalid LM Studio endpoints and malformed suggestions', async () => {
  assert.throws(() => new LmStudioClient('file:///tmp/model', 'test-model'), /HTTP\(S\) URL/);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"titles":"not-an-array"}' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const client = new LmStudioClient('http://127.0.0.1:1234/v1', 'test-model');
    const parsed = parseMediaPath('movies/Movies/Example (2020)/movie.mkv', 'movies/Movies');
    await assert.rejects(client.suggestSearchTitles('movies/Movies/Example (2020)/movie.mkv', parsed), /titles array/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
