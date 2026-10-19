// A tiny fake of the GitHub and Cursor Cloud Agents APIs Orb uses (src/server/github.ts,
// src/server/reposync.ts, src/server/agent/cursor.ts). Used by scripts/test-api.mjs and
// scripts/test-cursor-free.mjs: point ORB_GITHUB_API and ORB_CURSOR_API at it.
//
// The fake "agent" behaves like a real one: it streams narration and tool calls, gets the world
// through the files link in its prompt, works in a folder of its own and saves with the real
// `sh .orb/save`; its first run can hit the 30-minute limit ("mocklimit" in the prompt) so Orb has
// to start a follow-up run, and with "mocklook" it changes a file without saving it and looks at
// the world twice with the real `sh .orb/look`.
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** Run a command in `cwd` (stdin from `input`), resolving with its output. */
function runCmd(cmd, args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${out}`))));
    // A command that stops reading early (tar on an error page) closes the pipe: its exit code tells.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** The models the fake offers (a slice of Cursor's catalog, with Orb's preferred options). */
const MODELS = [
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', parameters: [{ id: 'context', values: [{ value: '300k' }, { value: '1m' }] }, { id: 'reasoning_effort', values: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value })) }] },
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', parameters: [{ id: 'context', values: [{ value: '300k' }, { value: '1m' }] }, { id: 'reasoning_effort', values: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value })) }] },
  { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', parameters: [{ id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] }, { id: 'context', values: [{ value: '300k' }, { value: '1m' }] }, { id: 'reasoning_effort', values: ['low', 'medium', 'high'].map((value) => ({ value })) }] },
];

export function startFake(port = 0) {
  /** repo full name → { refs: { main }, commits: Map(sha → Map(path → Buffer)) } */
  const repos = new Map();
  const blobs = new Map(); // sha → Buffer
  const trees = new Map(); // sha → Map(path → blob sha)
  const commits = new Map(); // sha → { tree, files: Map(path → Buffer) }
  const agents = new Map(); // id → { runs: [{ id, events, status, prompt }] }
  const log = [];

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  function commitFiles(repo, files, message) {
    const r = repos.get(repo);
    const treeSha = sha1('tree' + [...files.entries()].map(([p, b]) => p + sha1(b)).sort().join());
    trees.set(treeSha, new Map([...files.entries()].map(([p, b]) => { const s = sha1(`blob ${b.length}\0` + b.toString('binary')); blobs.set(s, b); return [p, s]; })));
    const sha = sha1(`${message}${Date.now()}${Math.random()}`);
    commits.set(sha, { tree: treeSha, files: new Map(files), message, parents: r.refs.main ? [r.refs.main] : [] });
    r.refs.main = sha;
    return sha;
  }
  const headFiles = (repo) => new Map(commits.get(repos.get(repo).refs.main)?.files ?? []);

  function tarGz(top, files) {
    const blocks = [];
    for (const [path, data] of files) {
      const h = Buffer.alloc(512);
      h.write(`${top}/${path}`.slice(0, 99), 0);
      h.write('0000644\0', 100);
      h.write('0000000\0', 108);
      h.write('0000000\0', 116);
      h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
      h.write('00000000000\0', 136);
      h.write('        ', 148);
      h.write('0', 156);
      h.write('ustar\0', 257);
      h.write('00', 263);
      let sum = 0;
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
      blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
  }

  /** What the fake agent does in a run: the world comes and goes through Orb's files link. */
  function playOrbRun(agent, run) {
    agent.link ??= /(https?:\/\/[^\s"]+\/api\/agent\/jobs\/[^\s"/]+\/files\?t=[\w-]+)/.exec(run.prompt)?.[1];
    const guide = /# Mode: guide/.test(agent.runs[0].prompt);
    const limit = /mocklimit/.test(run.prompt) && agent.runs.length === 1;
    const ev = [];
    let n = 0;
    const id = () => `${Date.now()}-${n++}`;
    const get = `curl -fsSL "${agent.link}" | tar -xzf -`;
    // Model calls, as the stream reports them: only how many tokens the model writes ("mockspend": a
    // lot). Not for "mockslow", whose every event takes 1.5 s against a 9-second build.
    const counted = !/mockslow/.test(agent.runs[0].prompt);
    const step = (stepId, tokens) =>
      counted ? [{ event: 'interaction_update', data: { type: 'step-started', stepId } }, ...[1, 2, 3, 4].map(() => ({ event: 'interaction_update', data: { type: 'token-delta', tokens: Math.round(tokens / 4) } }))] : [];
    const stepDone = (stepId) => (counted ? [{ event: 'interaction_update', data: { type: 'step-completed', stepId, stepDurationMs: 1000 } }] : []);
    ev.push(...step(0, /mockspend/.test(agent.runs[0].prompt) ? 30_000 : 200));
    ev.push({ event: 'thinking', data: { text: 'Let me get the world first. ' } });
    ev.push({ event: 'tool_call', data: { callId: 'd1', name: 'run_terminal_cmd', status: 'running', args: { command: get } } });
    ev.push({ do: async () => {
      agent.dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'fake-agent-'));
      const res = await fetch(agent.link);
      agent.downloads = (agent.downloads ?? 0) + 1;
      await runCmd('tar', ['-xzf', '-'], agent.dir, Buffer.from(await res.arrayBuffer()));
    } });
    ev.push({ event: 'tool_call', data: { callId: 'd1', name: 'run_terminal_cmd', status: 'completed', args: { command: get } } });
    if (guide) {
      ev.push({ do: async () => {
        // A guide may read but not save or look: try anyway, and remember Orb's answers.
        const res = await fetch(`${agent.link}&base=`, { method: 'PUT', body: zlib.gzipSync(Buffer.alloc(1024)) });
        agent.guideSave = { status: res.status, text: await res.text() };
        const seen = await fetch(agent.link.replace('/files?', '/files/look?'), { method: 'POST', body: zlib.gzipSync(Buffer.alloc(1024)) });
        agent.guideLook = { status: seen.status, text: await seen.text(), script: fs.existsSync(path.join(agent.dir, '.orb/look')) };
      } });
      // "mockchange": the visitor asked for a change, so the guide offers their own copy.
      const final = /mockchange/.test(agent.runs[0].prompt)
        ? "This world belongs to someone else, but you can make your own copy and I'll change it there!\nOwn copy: yes\nNext ideas: Find the door | Jump on clouds | Meet the cat"
        : 'Press space to jump, and look for the hidden door!\nNext ideas: Find the door | Jump on clouds | Meet the cat';
      ev.push({ event: 'assistant', data: { text: final } });
      ev.push(...stepDone(0));
      ev.push({ event: 'result', data: { status: 'FINISHED', text: final, durationMs: 3000 } });
    } else {
      // Messages come without newlines between them, like a real agent's.
      ev.push({ event: 'assistant', data: { text: agent.runs.length > 1 ? 'Picking up where I stopped!' : 'Ooh, building it now!' } });
      // "mocknoop": saving before changing anything, like an agent that saves in parallel with its edits.
      if (/mocknoop/.test(run.prompt)) ev.push({ do: async () => (agent.saves ??= []).push(await runCmd('sh', ['.orb/save'], agent.dir)) });
      // A finished edit reports the file's new contents (config.js), or only a diff in the newer
      // interaction events (main.js), as Cursor's stream does: Orb shows both before the save.
      const cfgDone = { callId: 'e1', name: 'edit_file', status: 'completed', args: { target_file: '/agent/src/config.js' } };
      const mainDone = { type: 'tool-call-completed', callId: 'e2', toolCall: { type: 'edit', args: { path: '/agent/src/main.js' }, result: { status: 'unchanged', value: {} } } };
      ev.push({ do: () => {
        const at = (p) => path.join(agent.dir, p);
        const cfg = fs.existsSync(at('src/config.js')) ? fs.readFileSync(at('src/config.js'), 'utf8') : 'export const CONFIG = { hue: 200 };\n';
        const hue = Number(/hue: (\d+)/.exec(cfg)?.[1] ?? 200) + 40;
        fs.mkdirSync(at('src'), { recursive: true });
        const config = `export const CONFIG = { hue: ${hue} };\n`;
        fs.writeFileSync(at('src/config.js'), config);
        cfgDone.result = { success: { path: '/agent/src/config.js', afterFullFileContent: config } };
        if (!fs.existsSync(at('index.html')) || !fs.readFileSync(at('index.html'), 'utf8').includes('main.js')) fs.writeFileSync(at('index.html'), '<!DOCTYPE html><html><head><title>Cursor Garden</title></head><body><script type="module" src="./src/main.js"></script></body></html>\n');
        const main = ["import { CONFIG } from './config.js';", 'document.body.style.background = `hsl(${CONFIG.hue} 50% 20%)`;'];
        if (!fs.existsSync(at('src/main.js'))) mainDone.toolCall.result = { status: 'success', value: { diffString: `--- a//agent/src/main.js\n+++ b//agent/src/main.js\n@@ -0,0 +1,2 @@\n${main.map((l) => `+${l}`).join('\n')}` } };
        fs.writeFileSync(at('src/main.js'), `${main.join('\n')}\n`);
      } });
      ev.push({ event: 'tool_call', data: { callId: 'e1', name: 'edit_file', status: 'running', args: { target_file: '/agent/src/config.js' } } });
      ev.push({ event: 'tool_call', data: cfgDone });
      ev.push({ event: 'interaction_update', data: mainDone });
      ev.push({ event: 'tool_call', data: { callId: 's1', name: 'run_terminal_cmd', status: 'running', args: { command: 'sh .orb/save' } } });
      ev.push({ do: async () => {
        (agent.saves ??= []).push(await runCmd('sh', ['.orb/save'], agent.dir));
      } });
      ev.push({ event: 'tool_call', data: { callId: 's1', name: 'run_terminal_cmd', status: 'completed', args: { command: 'sh .orb/save' } } });
      if (/mocklook/.test(run.prompt)) {
        // A change made with the shell (the stream doesn't show it), then two looks: the first plays
        // the world on a phone, the second just looks. What each printed and left in .orb/seen/ is kept.
        const looks = [
          `sh .orb/look '{"actions":[{"type":"key","key":"w","ms":300},{"type":"screenshot","label":"Walking up"}],"viewport":"phone"}'`,
          'sh .orb/look',
        ];
        ev.push({ do: () => fs.appendFileSync(path.join(agent.dir, 'src/main.js'), '// tuned while looking\n') });
        looks.forEach((command, i) => {
          ev.push({ event: 'tool_call', data: { callId: `l${i}`, name: 'run_terminal_cmd', status: 'running', args: { command } } });
          ev.push({ do: async () => {
            const said = await runCmd('sh', ['-c', command], agent.dir);
            const dir = path.join(agent.dir, '.orb/seen');
            const seen = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
            (agent.looks ??= []).push({ said, seen, files: Object.fromEntries(seen.map((f) => [f, fs.readFileSync(path.join(dir, f))])) });
          } });
          ev.push({ event: 'tool_call', data: { callId: `l${i}`, name: 'run_terminal_cmd', status: 'completed', args: { command } } });
        });
        // Opening a screenshot to see it.
        ev.push({ event: 'tool_call', data: { callId: 'v1', name: 'read_file', status: 'running', args: { path: '/agent/.orb/seen/1-walking-up.png' } } });
        ev.push({ event: 'tool_call', data: { callId: 'v1', name: 'read_file', status: 'completed', args: { path: '/agent/.orb/seen/1-walking-up.png' } } });
      }
      ev.push(...stepDone(0));
      if (limit) {
        ev.push({ event: 'result', data: { status: 'ERROR', durationMs: 1800500 } });
      } else {
        // Like a real agent, it tells what it didn't verify (Orb leaves that out of the chat).
        const final = "Your garden glows in new colors — tap around! I haven't opened it in a browser to test it.\nNext ideas: Make it sunset | Add fireflies | Add soft music";
        ev.push(...step(1, 60));
        ev.push({ event: 'assistant', data: { text: final } });
        ev.push(...stepDone(1));
        ev.push({ event: 'result', data: { status: 'FINISHED', text: final, durationMs: 4000 } });
      }
    }
    ev.push({ event: 'done', data: {} });
    run.events = ev.map((e) => ({ ...e, id: id() }));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : {};
    log.push(`${req.method} ${p}`);
    let m;

    // ---- GitHub ----
    if (p === '/user') return send(res, 200, { login: 'tester' });
    if (req.method === 'POST' && p === '/user/repos') {
      const full = `tester/${json.name}`;
      if (repos.has(full)) return send(res, 422, { message: 'name already exists on this account' });
      repos.set(full, { refs: {}, description: json.description });
      commitFiles(full, new Map([['README.md', Buffer.from('# hi\n')]]), 'Initial commit');
      return send(res, 201, { full_name: full });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p))) {
      const r = repos.get(m[1]);
      return r ? send(res, 200, { full_name: m[1], description: r.description, permissions: { push: true } }) : send(res, 404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/main$/.exec(p))) {
      const r = repos.get(m[1]);
      return r?.refs.main ? send(res, 200, { object: { sha: r.refs.main } }) : send(res, 404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/commits\/(\w+)$/.exec(p)) && req.method === 'GET') {
      const c = commits.get(m[2]);
      return c ? send(res, 200, { tree: { sha: c.tree } }) : send(res, 404, {});
    }
    // a branch's head commit (GET /repos/<repo>/commits/<branch>), and git's ref list (what Orb reads for public repositories)
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/commits\/(main|[0-9a-f]{40})$/.exec(p)) && req.method === 'GET') {
      const sha = m[2] === 'main' ? repos.get(m[1])?.refs.main : commits.has(m[2]) ? m[2] : null;
      return sha ? send(res, 200, { sha, commit: { message: commits.get(sha)?.message ?? '' } }) : send(res, 404, { message: 'Not Found' });
    }
    if ((m = /^\/([^/]+\/[^/]+)\.git\/info\/refs$/.exec(p)) && req.method === 'GET') {
      const sha = repos.get(m[1])?.refs.main;
      if (!sha) return send(res, 404, {});
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
      return res.end(`001e# service=git-upload-pack\n0000${sha} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=fake\n003f${sha} refs/heads/main\n0000`);
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/(\w+)$/.exec(p)) && req.method === 'GET') {
      const t = trees.get(m[2]);
      return t ? send(res, 200, { tree: [...t.entries()].map(([path, sha]) => ({ path, type: 'blob', sha })) }) : send(res, 404, {});
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/blobs$/.exec(p))) {
      const b = Buffer.from(json.content, 'base64');
      const s = sha1(`blob ${b.length}\0` + b.toString('binary'));
      blobs.set(s, b);
      return send(res, 201, { sha: s });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/trees$/.exec(p))) {
      const base = json.base_tree ? new Map(trees.get(json.base_tree)) : new Map();
      for (const e of json.tree) {
        if (e.sha === null) base.delete(e.path);
        else base.set(e.path, e.sha);
      }
      const s = sha1('tree' + JSON.stringify([...base.entries()]) + Math.random());
      trees.set(s, base);
      return send(res, 201, { sha: s });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/commits$/.exec(p))) {
      const t = trees.get(json.tree);
      const s = sha1(json.message + Math.random());
      commits.set(s, { tree: json.tree, files: new Map([...t.entries()].map(([path, b]) => [path, blobs.get(b)])), message: json.message, parents: json.parents ?? [] });
      return send(res, 201, { sha: s });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/refs(\/heads\/main)?$/.exec(p))) {
      const r = repos.get(m[1]);
      // like GitHub: without force, the new commit has to come after the branch's head
      if (m[2] && json.force === false && r.refs.main && !(commits.get(json.sha)?.parents ?? []).includes(r.refs.main)) return send(res, 422, { message: 'Update is not a fast forward' });
      r.refs.main = json.sha;
      return send(res, m[2] ? 200 : 201, {});
    }
    // codeload.github.com/<owner>/<repo>/tar.gz/<ref> (what Orb's importer downloads): the repository's head
    if ((m = /^\/codeload\/([^/]+)\/([^/]+)\/tar\.gz\/([^/]+)$/.exec(p))) {
      if (!repos.has(`${m[1]}/${m[2]}`)) return send(res, 404, {});
      const at = commits.get(m[3]);
      res.writeHead(200, { 'content-type': 'application/x-gzip' });
      return res.end(tarGz(`${m[2]}-head`, at ? at.files : headFiles(`${m[1]}/${m[2]}`)));
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/tarball\/(\w+)$/.exec(p))) {
      const c = commits.get(m[3]);
      if (!c) return send(res, 404, {});
      res.writeHead(200, { 'content-type': 'application/x-gzip' });
      return res.end(tarGz(`${m[1]}-${m[2]}-${m[3].slice(0, 7)}`, c.files));
    }

    // ---- Cursor ----
    if (req.method === 'GET' && p === '/v1/models') return send(res, 200, { items: MODELS });
    if (req.method === 'POST' && p === '/v1/agents') {
      if (/mockdenied/.test(json.prompt?.text ?? '')) return send(res, 401, { error: { code: 'unauthorized', message: 'Invalid API key' } });
      const id = `bc-${crypto.randomUUID()}`;
      const run = { id: `run-${crypto.randomUUID()}`, prompt: json.prompt?.text ?? '', status: 'RUNNING' };
      const agent = { id, name: json.name, runs: [run], model: json.model, auth: req.headers.authorization };
      agents.set(id, agent);
      playOrbRun(agent, run);
      return send(res, 200, { agent: { id, name: json.name, latestRunId: run.id }, run: { id: run.id } });
    }
    if (req.method === 'GET' && p === '/v1/agents') return send(res, 200, { items: [...agents.values()].map((a) => ({ id: a.id, name: a.name, latestRunId: a.runs.at(-1).id })) });
    if ((m = /^\/v1\/agents\/([^/]+)\/runs$/.exec(p)) && req.method === 'POST') {
      const agent = agents.get(m[1]);
      const run = { id: `run-${crypto.randomUUID()}`, prompt: json.prompt?.text ?? '', status: 'RUNNING' };
      agent.runs.push(run);
      playOrbRun(agent, run);
      return send(res, 200, { run: { id: run.id } });
    }
    if ((m = /^\/v1\/agents\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(p))) return send(res, 200, {});
    if ((m = /^\/v1\/agents\/([^/]+)\/runs\/([^/]+)\/stream$/.exec(p))) {
      const run = agents.get(m[1])?.runs.find((r) => r.id === m[2]);
      if (!run) return send(res, 404, {});
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const after = req.headers['last-event-id'];
      let i = after ? run.events.findIndex((e) => e.id === after) + 1 : 0;
      const slow = /mockslow/.test(agents.get(m[1]).runs[0].prompt) ? 1500 : 60;
      for (; i < run.events.length; i++) {
        const e = run.events[i];
        await new Promise((r) => setTimeout(r, slow));
        if (res.destroyed) return;
        if (e.do) {
          if (!e.done) {
            e.done = true;
            await Promise.resolve()
              .then(e.do)
              .catch((err) => log.push(`agent action failed: ${err.message}`));
          }
          continue;
        }
        res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      }
      return res.end();
    }
    if ((m = /^\/v1\/agents\/([^/]+)\/runs\/([^/]+)$/.exec(p))) return send(res, 200, { id: m[2], status: 'RUNNING' });
    send(res, 404, { message: `fake: no route ${req.method} ${p}` });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({
        port: server.address().port,
        repos,
        agents,
        log,
        headFiles,
        /** A public repository with these files ({ path: string }), as codeload serves it. */
        addRepo: (name, files) => {
          repos.set(name, { refs: {} });
          commitFiles(name, new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)])), 'init');
        },
        /** A push to the repository's main: these files changed (null deletes one). */
        pushFiles: (name, changes, message = 'a change') => {
          const files = new Map(headFiles(name));
          for (const [p, t] of Object.entries(changes)) if (t === null) files.delete(p); else files.set(p, Buffer.from(t));
          return commitFiles(name, files, message);
        },
        /** The files at the head of main, as text. */
        headText: (name) => Object.fromEntries([...headFiles(name)].map(([p, b]) => [p, b.toString('utf8')])),
        close: () => server.close(),
      })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await startFake(Number(process.argv[2]) || 3109);
  console.log(`fake GitHub + Cursor on :${f.port}`);
}
