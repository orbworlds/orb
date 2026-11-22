// 3D models attached to a chat message (src/server/uploads.ts, src/server/agent/photos.ts): the
// files Orb takes and how it tells them apart, a model put together from its parts, where a build
// puts it in the world and what it tells the AI, and the build request naming it — against an
// in-memory PGlite with the app's own schema.
import { register } from 'node:module';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DDL } from '../../../server/ddl.mjs';

register('./resolve-hooks.mjs', import.meta.url);

const U = await import('../../../server/uploads.ts');
const P = await import('../../../server/agent/photos.ts');
const F = await import('../../../server/files.ts');
const { validateBuildRequest, MODELS_ONLY } = await import('../prompt.ts');

const glb = (n = 64) => {
  const b = Buffer.alloc(n);
  b.write('glTF', 0, 'latin1');
  b.writeUInt32LE(2, 4);
  b.writeUInt32LE(n, 8);
  return b;
};
const stlBinary = (triangles) => {
  const b = Buffer.alloc(84 + 50 * triangles);
  b.writeUInt32LE(triangles, 80);
  return b;
};

describe('the files Orb takes', () => {
  test('a model’s name as a world keeps it', () => {
    assert.equal(U.modelName('Knight.GLB'), 'Knight.glb');
    assert.equal(U.modelName('C:\\models\\my knight (v2).fbx'), 'my knight -v2.fbx');
    assert.equal(U.modelName('../../etc/passwd.obj'), 'passwd.obj');
    assert.equal(U.modelName('Café.stl'), 'Cafe.stl');
    assert.equal(U.modelName('.glb'), 'model.glb');
    assert.equal(U.modelName('photo.png'), null);
    assert.equal(U.modelName('no-extension'), null);
  });

  test('each kind by how it starts', () => {
    assert.equal(U.modelType('a.glb', glb()), 'glb');
    assert.equal(U.modelType('a.glb', Buffer.from('not a glb, just text here')), null);
    assert.equal(U.modelType('a.gltf', Buffer.from('{"asset":{"version":"2.0"}}')), 'gltf');
    assert.equal(U.modelType('a.fbx', Buffer.concat([Buffer.from('Kaydara FBX Binary  \0'), Buffer.alloc(40)])), 'fbx');
    assert.equal(U.modelType('a.fbx', Buffer.from('; FBX 7.4.0 project file\n')), 'fbx');
    assert.equal(U.modelType('a.obj', Buffer.from('# a cube\nv 0 0 0\nv 1 0 0\nf 1 2 3\n')), 'obj');
    assert.equal(U.modelType('a.obj', Buffer.from('just some words in a file')), null);
    assert.equal(U.modelType('a.stl', Buffer.from('solid cube\nfacet normal 0 0 1\nendsolid\n')), 'stl');
    assert.equal(U.modelType('a.stl', stlBinary(2)), 'stl');
    assert.equal(U.modelType('a.stl', Buffer.alloc(200)), null, 'a binary STL’s length must match its triangles');
  });
});

describe('uploading and building', () => {
  let pg;
  let db;
  const viewer = { deviceHash: 'dev-hash', deviceId: 'dev', userId: null };
  before(async () => {
    pg = new PGlite();
    await pg.waitReady;
    await pg.exec(DDL);
    db = { kind: 'pglite', query: async (text, params = []) => (await pg.query(text, params)).rows };
  });
  after(async () => {
    await pg?.close();
  });

  test('a model put together from its parts, in order', async () => {
    const whole = glb(9000);
    const a = await U.uploadPart(db, viewer, whole.subarray(0, 4000));
    const b = await U.uploadPart(db, viewer, whole.subarray(4000));
    const m = await U.joinModel(db, viewer, [a.sha, b.sha], 'Hero Knight.glb');
    assert.deepEqual({ name: m.name, type: m.type, size: m.size }, { name: 'Hero Knight.glb', type: 'glb', size: 9000 });
    assert.deepEqual(Buffer.from(await F.getBlob(db, m.sha)), whole);
  });

  test('what isn’t a model, or isn’t all there, is turned away', async () => {
    const part = await U.uploadPart(db, viewer, Buffer.from('plain words, not a model at all'));
    await assert.rejects(() => U.joinModel(db, viewer, [part.sha], 'thing.glb'), (e) => e.status === 415);
    await assert.rejects(() => U.joinModel(db, viewer, [part.sha], 'thing.png'), (e) => e.status === 415);
    await assert.rejects(() => U.joinModel(db, viewer, ['0'.repeat(64)], 'thing.glb'), (e) => e.status === 400 && e.code === 'missing_part');
    const gltf = await U.uploadPart(db, viewer, Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'scene.bin', byteLength: 10 }] })));
    await assert.rejects(() => U.joinModel(db, viewer, [gltf.sha], 'scene.gltf'), (e) => e.status === 415 && e.code === 'gltf_files');
    await assert.rejects(() => U.joinModel(db, { deviceHash: null, deviceId: null, userId: null }, [part.sha], 'thing.glb'), (e) => e.status === 400);
  });

  test('a build puts it in the world’s files as models/<name>, and says so', async () => {
    const m = await U.joinModel(db, viewer, [(await U.uploadPart(db, viewer, glb(2_500_000))).sha], 'knight.glb');
    const model = { sha: m.sha, name: m.name, type: m.type };
    const built = await P.buildModels(db, [model], true, {});
    assert.deepEqual(built.files, { 'models/knight.glb': m.sha });
    const note = P.modelNote([model], built);
    assert.match(note, /models\/knight\.glb \(GLB, 2\.5 MB\)/);
    assert.match(note, /GLTFLoader/);
    assert.match(note, /left out when it's saved/);
    // A different file of that name already in the world: the new one's sha goes in its name.
    const taken = await P.buildModels(db, [model], true, { 'models/knight.glb': 'f'.repeat(64) });
    assert.deepEqual(Object.keys(taken.files), [`models/knight-${m.sha.slice(0, 6)}.glb`]);
    // Not a build (a guide answering): not in the world, only named.
    const asked = await P.buildModels(db, [model], false, {});
    assert.deepEqual(asked.paths, []);
    assert.match(P.modelNote([model], asked), /knight\.glb, which you can't see/);
  });

  test('the build request names models (up to three); one with no words says so', () => {
    const sha = 'a'.repeat(64);
    const ok = validateBuildRequest({ messages: [{ role: 'user', content: '' }], models: [{ sha, name: 'knight.glb', type: 'glb', extra: 1 }] });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.req.models, [{ sha, name: 'knight.glb', type: 'glb' }]);
    assert.equal(ok.req.messages.at(-1).content, MODELS_ONLY);
    assert.equal(validateBuildRequest({ messages: [{ role: 'user', content: 'x' }], models: [{ sha, name: 'a.zip', type: 'zip' }] }).ok, false);
    assert.equal(validateBuildRequest({ messages: [{ role: 'user', content: 'x' }], models: Array(4).fill({ sha, name: 'a.glb', type: 'glb' }) }).ok, false);
  });
});
