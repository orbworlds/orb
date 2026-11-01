// Run all engine tests: node --test --experimental-strip-types src/lib/engine/__tests__/*.test.mjs
// Files from the web for a world (src/server/agent/assets.ts): only public https sites, only files
// that are what their name says, and what a model is like.
import './setup.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { isPrivateAddress, urlProblem, assetProblem, pathProblem, fetchAsset, modelInfo } = await import('../../../server/agent/assets.ts');
const { closeToolCalls } = await import('../../../server/agent/workspace.ts');

/** A tiny .glb: a JSON chunk only. */
function glb(json) {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(20 + body.length);
  const v = new DataView(out.buffer);
  out.set(new TextEncoder().encode('glTF'), 0);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, body.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(body, 20);
  return out;
}

describe('files from the web', () => {
  test('private addresses are told apart from public ones', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])
      assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['8.8.8.8', '185.199.110.133', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
  });

  test('only https links with a site’s name, on its usual port', () => {
    assert.match(urlProblem(new URL('http://example.com/a.glb')), /https/);
    assert.ok(urlProblem(new URL('https://user:pw@example.com/a.glb')));
    assert.ok(urlProblem(new URL('https://example.com:8443/a.glb')));
    assert.match(urlProblem(new URL('https://127.0.0.1/a.glb')), /name/);
    assert.match(urlProblem(new URL('https://[::1]/a.glb')), /name/);
    assert.equal(urlProblem(new URL('https://raw.githubusercontent.com/a/b/main/fox.glb')), null);
  });

  test('a name that leads to this machine is refused as the connection is made', async () => {
    const r = await fetchAsset('https://localhost/model.glb');
    assert.match(r.error, /public site/);
    assert.match((await fetchAsset('not a link')).error, /isn’t a link/);
  });

  test('a file is what its name says: a web page or another kind is refused', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    assert.equal(assetProblem('assets/a.png', png), null);
    assert.match(assetProblem('assets/a.glb', png), /isn't a \.glb/);
    assert.match(assetProblem('assets/a.png', new TextEncoder().encode('<!doctype html><html>')), /web page/);
    assert.match(pathProblem('assets/a.exe'), /\.glb/);
    assert.equal(pathProblem('assets/sky.hdr'), null);
    assert.equal(assetProblem('assets/sky.hdr', new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe')), null);
    assert.equal(assetProblem('assets/fox.glb', glb({ asset: { version: '2.0' } })), null);
    assert.match(assetProblem('assets/a.mp3', new Uint8Array()), /empty/);
  });

  test('a model tells its size, its animations and the files it needs', () => {
    const json = {
      asset: { version: '2.0' },
      accessors: [{ min: [-0.5, 0, -0.25], max: [0.5, 1.8, 0.25] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      animations: [{ name: 'Idle' }, { name: 'Walk' }, {}],
      buffers: [{ uri: 'fox.bin' }],
      images: [{ uri: 'data:image/png;base64,AAAA' }, { uri: 'fur.png' }],
    };
    const info = modelInfo('assets/fox.glb', glb(json));
    assert.match(info, /1\.00 × 1\.80 × 0\.50/);
    assert.match(info, /y from 0\.00 to 1\.80/);
    assert.match(info, /animations: Idle, Walk, #2/);
    assert.match(info, /fox\.bin, fur\.png/);
    assert.match(modelInfo('assets/fox.gltf', new TextEncoder().encode(JSON.stringify(json))), /Idle/);
    assert.equal(modelInfo('assets/a.png', new Uint8Array([1, 2, 3])), '');
  });

  test('a tool Anthropic runs itself (web search) isn’t answered again', () => {
    const added = [
      { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 's1', toolName: 'web_search', input: { query: 'cc0 fox glb' }, providerExecuted: true },
        { type: 'tool-result', toolCallId: 's1', toolName: 'web_search', output: { type: 'json', value: [] }, providerExecuted: true },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'write_file', input: {} },
      ] },
    ];
    const out = closeToolCalls(added, new Map([['c1', 'Created x']]));
    const answered = out.filter((m) => m.role === 'tool').flatMap((m) => m.content.map((p) => p.toolCallId));
    assert.deepEqual(answered, ['c1']);
  });
});
