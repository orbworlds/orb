// Cursor builds on a world's files (the free builder on Orb's own Cursor key, or a person's own key):
// a Cursor Cloud Agent gets the world's files from Orb and saves them back through the job's files
// link (./sync.ts); each save is pulled from the job's inbox into the world (live preview + a saved
// version, which goes to the world's GitHub repository like any build's, ../reposync.ts). One tick
// follows the agent's run stream for a few minutes and hands over; runs that hit Cursor's per-run
// time limit are continued with a follow-up run, so a build can go on for hours or days.

import { cursorCall, cursorInput, cursorOutput, cursorTokens, cursorUsd, type CursorTokens } from '../budget';
import { authHeaders, BASE, call, cancelCursorRun, CursorError, describeCursorError, parseJson, readSse, runPath, startCursorAgent, waitForRun } from '../cursor';
import { cleanPath as cleanTreePath, getText, getTree, putBlob, putTree, type Tree } from '../files';
import { recordError } from '../errors';
import { withDeadline } from '../signals';
import { cursorSegment } from '../traces';
import { closeLooks, LOOK_SIZE, SEEN_DIR, takeLookRequests } from './look';
import { applyUnifiedDiff, streamedEdit, type StreamedEdit } from './mirror';
import { narration } from './narration';
import { isSaveFile } from './sync';
import { CURSOR_ORB_CONTINUE, FILES_URL } from './prompt';
import type { TickCtx, TickResult } from './runner';
import { PROBE_LIMITS } from '../../lib/probe';

/** What a Cursor job remembers between ticks (orb_agent_jobs.ext). */
export interface CursorState {
  agentId?: string;
  runs?: string[];
  runIndex?: number;
  lastId?: string | null;
  /** The saved tree last pulled into the world. */
  pulledTree?: string | null;
  /** Consecutive runs that ended without pushing or saying anything. */
  idle?: number;
  /** Whether the current run pushed or said anything yet. */
  active?: boolean;
  /** The free builder: the agent's tokens so far, for what the build costs (../budget.ts)… */
  tokens?: CursorTokens;
  /** …and how much of that was charged to the day's budget (millionths of a US$). */
  charged?: number;
}

/** Saves through Orb's link are a row in the database: cheap to look for. */
const INBOX_EVERY_MS = 4_000;
/** So are the agent's looks (sh .orb/look), and the agent waits for each one. */
const LOOKS_EVERY_MS = 2_000;
/** A build goes on in follow-up runs, each up to Cursor's 30 minutes, until it's done: at most ~12 days. */
const MAX_RUNS = 600;
const NEXT_IDEAS = /^\s*next ideas:\s*(.+)$/im;
/** A guide's line saying the person wants a change: the page offers them their own copy. */
const OWN_COPY = /^\s*own copy:\s*yes\b.*$/im;
const FREE_DOWN = 'The free builder is resting right now. You can keep building by adding your own AI key in You → Model.';
const FREE_PAUSE = "I've worked on this for a good while, so I'll pause here — say “keep going” and I'll continue!";

const basename = (p: string) => p.split('/').pop() || p;
const cleanPath = (p: unknown) => (typeof p === 'string' ? p.replace(/^\/?(workspace|agent)\//, '').replace(/^\.\//, '') : '');

/** A Cursor failure in the free builder's words (the person can't fix Orb's own key), and whether it is Orb's problem. */
function freeFailure(e: unknown): { message: string; record: boolean } {
  const d = describeCursorError(e);
  if (d.code === 'rate_limited') return { message: "Orb's free builder is very busy right now — try again in a minute.", record: false };
  if (d.code === 'bad_key' || /out of usage/.test(d.message)) return { message: FREE_DOWN, record: true };
  return { message: d.message, record: d.code === 'bad_request' };
}

function toolPath(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  return cleanPath(args.target_file ?? args.targetFile ?? args.file_path ?? args.filePath ?? args.path ?? args.relativeWorkspacePath ?? args.targetDirectory ?? '');
}


export async function cursorTick(c: TickCtx): Promise<TickResult> {
  const { db, job, out } = c;
  const apiKey = c.apiKey;
  if (!apiKey || !c.filesUrl) return c.finish('failed', c.shared ? FREE_DOWN : 'This build needs your Cursor key — check it in You → Model and try again.');
  const withLink = (text: string) => text.replaceAll(FILES_URL, c.filesUrl!);
  const st: CursorState = { ...(c.ext as CursorState) };
  const deadline = c.startedAt + c.hardMs;
  const saveState = () => c.save({ ext: JSON.stringify(st) });

  // -- pulling the agent's saves into the world -------------------------------------------------
  const sync: { pulling: Promise<void> | null } = { pulling: null };
  let lastPull = Date.now();
  const titleOf = async (tree: string | null): Promise<string | null> => {
    const files = tree ? await getTree(db, tree) : null;
    const page = files?.['index.html'] ? await getText(db, files['index.html']) : null;
    return (page && /<title>([^<]{1,60})<\/title>/i.exec(page)?.[1]?.trim()) || null;
  };
  /** The page's title before this build (a starter's own "A quiet little island"): not a name the agent gave. */
  let startTitle: Promise<string | null> | null = null;
  /** The newest files the agent saved, if they are new. */
  const fetchNew = async (): Promise<string | null> => {
    const rows = await db.query<{ inbox: string | null }>(`select inbox from orb_agent_jobs where id = $1`, [job.id]);
    const inbox = rows[0]?.inbox ?? null;
    if (!inbox || inbox === st.pulledTree) return null;
    st.pulledTree = inbox;
    return inbox;
  };
  const pull = (): Promise<void> => {
    if (sync.pulling) return sync.pulling;
    lastPull = Date.now();
    sync.pulling = (async () => {
      try {
        const tree = await fetchNew();
        if (!tree) return;
        st.active = true;
        // An untitled world takes the name the agent gave its page.
        if (!c.meta.name) {
          const title = await titleOf(tree);
          startTitle ??= titleOf(job.base_tree);
          if (title && title !== (await startTitle) && !/^(untitled|orb|document|index)$/i.test(title)) c.meta.name = title;
        }
        // The edits may be on screen already (mirrored): the save makes them a version.
        if (tree !== c.getTree()) await c.setTree(tree);
        await c.commit();
        await saveState();
      } catch (e) {
        console.error('[orb] pulling the agent’s save failed', e instanceof Error ? e.message : e);
      }
    })().finally(() => {
      sync.pulling = null;
    });
    return sync.pulling;
  };

  // -- the agent's edits, on screen as soon as each is done ---------------------------------------
  const mirrored = new Set<string>();
  let mirroring: Promise<void> = Promise.resolve();
  const mirror = (key: string, edit: StreamedEdit): void => {
    const path = cleanTreePath(edit.path);
    if (!key || mirrored.has(key) || !path || isSaveFile(path)) return;
    mirrored.add(key);
    mirroring = mirroring.then(async () => {
      try {
        const sha = c.getTree();
        const files: Tree = { ...((sha && (await getTree(db, sha))) || {}) };
        const after = edit.after ?? (edit.diff === undefined ? null : applyUnifiedDiff((files[path] && (await getText(db, files[path]))) || '', edit.diff));
        if (after === null) return; // doesn't fit Orb's copy: the next save brings it
        files[path] = (await putBlob(db, after)).sha;
        const next = await putTree(db, files);
        st.active = true;
        if (next !== c.getTree()) await c.setTree(next);
      } catch (e) {
        console.error('[orb] showing an agent edit failed', e instanceof Error ? e.message : e);
      }
    });
  };
  /** The edits shown so far, then the newest push or save (which has the last word). */
  const settle = async (): Promise<void> => {
    await mirroring;
    await pull();
  };

  // -- the agent looking at the world (sh .orb/look, ./look.ts) ------------------------------------
  const looking: { serving: Promise<void> | null } = { serving: null };
  /** Close the looks that are over, then pass the agent's new ones on to the pages, its files on screen first. */
  const serveLooks = (): Promise<void> => {
    if (looking.serving) return looking.serving;
    looking.serving = (async () => {
      try {
        for (const l of await closeLooks(db, job.id)) {
          out.control({ t: 'looked', id: l.id });
          c.trace.look({ lookId: l.id, callId: '', actions: l.request.actions, skipped: l.request.skipped, answer: l.answer, ms: l.ms });
        }
        const asked = await takeLookRequests(db, job.id);
        if (!asked.length) return;
        await settle();
        for (const l of asked) {
          if (l.request.tree !== c.getTree()) await c.setTree(l.request.tree);
          out.control({ t: 'status', phase: 'thinking', text: l.request.viewport === 'phone' ? 'Trying it on a phone…' : 'Trying it out…' });
          out.control({ t: 'look', job: job.id, id: l.id, tree: l.request.tree, actions: l.request.actions, size: LOOK_SIZE, shots: PROBE_LIMITS.shots, ...(l.request.viewport ? { viewport: l.request.viewport } : {}) });
        }
        await out.flush();
      } catch (e) {
        console.error('[orb] passing on the agent’s look failed', e instanceof Error ? e.message : e);
      }
    })().finally(() => {
      looking.serving = null;
    });
    return looking.serving;
  };
  let lookTimer: ReturnType<typeof setInterval> | undefined;

  // -- the free builder's budget (../budget.ts) ---------------------------------------------------
  /** Set once the day's budget or the maker's credits are spent: the agent stops at its next model call. */
  let budgetStop: string | null = null;
  /** Charge what the run cost since the last charge. */
  const bill = async (): Promise<void> => {
    if (!c.charge || !st.tokens) return;
    const due = Math.round(cursorUsd(job.model, st.tokens) * 1e6) - (st.charged ?? 0);
    if (due > 0) {
      st.charged = (st.charged ?? 0) + due;
      budgetStop = (await c.charge(due / 1e6)) ?? budgetStop;
    }
    c.meta.costUsd = (st.charged ?? 0) / 1e6;
  };

  try {
    // -- first tick: the agent ----------------------------------------------------------------------
    if (!st.agentId) {
      st.pulledTree = job.tree;
      out.control({ t: 'status', phase: 'thinking', text: 'Getting ready to build…' });
      const { text, images } = c.prompt();
      const run = await startCursorAgent({
        apiKey,
        text: withLink(text),
        images,
        model: job.model ?? undefined,
        modelParams: c.cursorParams,
        signal: c.signal,
        maxWaitMs: 120_000,
      });
      Object.assign(st, { agentId: run.agentId, runs: [run.runId], runIndex: 0, lastId: null, idle: 0, active: false });
      if (c.charge) st.tokens = cursorTokens(withLink(text).length);
      c.trace.note('run', { text, images: images.length, run: 0, runId: run.runId, agentId: run.agentId });
      await saveState();
    }

    // -- following the agent ---------------------------------------------------------------------
    await serveLooks();
    lookTimer = setInterval(() => void serveLooks(), LOOKS_EVERY_MS);
    let finalText = '';
    let done = false;
    let thought = '';
    let lastThought = 0;
    let pending = ''; // narration held back until a line is complete (the ideas line is not shown)
    let streamed = ''; // everything the agent said as it went
    let spoke = false;
    let afterTools = false; // a message after tool calls is a new one: it starts on its own line
    let writing = 0; // tokens of code the agent is writing (the stream only counts them)
    let lastWriting = 0;
    const flushSay = (all: boolean) => {
      let upto = all ? pending.length : pending.lastIndexOf('\n') + 1;
      if (upto <= 0) return;
      let text = pending.slice(0, upto);
      pending = pending.slice(upto);
      text = text.replace(/^\s*next ideas:.*$/gim, '').replace(/^\s*own copy:.*$/gim, '');
      out.say(narration(text));
      upto = 0;
    };

    const until = deadline;
    while (!done && Date.now() < until) {
      if (out.cancelled || c.signal.aborted) break;
      const runId = st.runs![st.runIndex!];
      let result: Record<string, unknown> | null = null;
      let res: Response | null = null;
      try {
        res = await fetch(`${BASE}${runPath({ agentId: st.agentId!, runId })}/stream`, {
          headers: { ...authHeaders(apiKey), Accept: 'text/event-stream', ...(st.lastId ? { 'Last-Event-ID': st.lastId } : {}) },
          signal: withDeadline(c.signal, Math.max(1000, until - Date.now())),
        });
      } catch {
        res = null;
      }
      if (res && (res.status === 401 || res.status === 403)) throw new CursorError(res.status, 'Cursor rejected that API key');
      if (res && res.ok && res.body) {
        const timer = setInterval(() => {
          if (Date.now() - lastPull > INBOX_EVERY_MS) void pull();
        }, 2000);
        const seg = cursorSegment(c.trace, st.runIndex ?? 0, runId);
        try {
          for await (const ev of readSse(res.body)) {
            if (ev.id) st.lastId = ev.id;
            const d = parseJson(ev.data);
            seg.add(ev.event, d);
            const edit = streamedEdit(ev.event, d);
            if (edit) mirror(`${st.runIndex ?? 0}:${String(d.callId ?? '')}`, edit);
            if (ev.event === 'interaction_update') {
              if (st.tokens) {
                if (d.type === 'step-started') cursorCall(st.tokens);
                else if (d.type === 'token-delta') cursorOutput(st.tokens, Number(d.tokens) || 0);
                else if (d.type === 'tool-call-completed') cursorInput(st.tokens, JSON.stringify((d.toolCall as { result?: unknown } | undefined)?.result ?? '').length);
              }
              if (d.type === 'step-completed') {
                await bill();
                if (budgetStop) break;
              }
              // Only token counts arrive while the agent writes code: show that something grows.
              if (d.type === 'token-delta') {
                writing += Number(d.tokens) || 0;
                if (writing >= 80 && Date.now() - lastWriting > 2500) {
                  lastWriting = Date.now();
                  out.control({ t: 'status', phase: 'thinking', text: `Writing the world… about ${Math.round(writing / 14)} lines so far` });
                }
              } else if (d.type === 'thinking-delta' || d.type === 'text-delta' || d.type === 'tool-call-completed') writing = 0;
            } else if (ev.event === 'assistant' && typeof d.text === 'string') {
              st.active = true;
              if (afterTools && spoke && !/^\s/.test(d.text)) pending += '\n';
              afterTools = false;
              spoke = true;
              pending += d.text;
              streamed += d.text;
              flushSay(false);
            } else if (ev.event === 'thinking' && typeof d.text === 'string') {
              thought = (thought + d.text).slice(-600);
              if (Date.now() - lastThought > 3000) {
                lastThought = Date.now();
                const parts = thought.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter((p) => p.length > 12);
                out.control({ t: 'status', phase: 'thinking', text: (parts[parts.length - 1] ?? '').slice(0, 180) });
              }
            } else if (ev.event === 'tool_call') {
              // The agent moved on from talking: what it said is complete, so it shows now.
              if (!afterTools && pending.trim()) flushSay(true);
              afterTools = true;
              toolEvent(c, d, st.runIndex ?? 0, () => void pull());
            } else if (ev.event === 'result') {
              result = d;
            } else if (ev.event === 'error') {
              throw new CursorError(502, String(d.message || d.code || 'Cursor stream error'));
            } else if (ev.event === 'done') break;
          }
        } catch (e) {
          if (e instanceof CursorError) throw e;
          // dropped, or out of time: the loop decides
        } finally {
          clearInterval(timer);
          seg.end();
        }
        await bill();
        // A run that just finished ends as usual; one still going stops below.
        if (budgetStop && !result) break;
      } else {
        await res?.body?.cancel().catch(() => undefined);
        if (res && (res.status === 404 || res.status === 410)) {
          // No stream (expired): wait for the run to end instead.
          const info = await waitForRun(apiKey, { agentId: st.agentId!, runId }, c.signal, until);
          if (info) result = { status: info.status, text: info.result ?? '', durationMs: (info as { durationMs?: number }).durationMs };
        } else await new Promise((r) => setTimeout(r, 2000));
      }
      if (!result) continue;

      flushSay(true);
      const status = String(result.status || '').toUpperCase();
      const text = typeof result.text === 'string' ? result.text : '';
      await settle();
      st.idle = st.active ? 0 : (st.idle ?? 0) + 1;
      if (status === 'FINISHED' || status === 'COMPLETED') {
        finalText = text;
        done = true;
        break;
      }
      const hitLimit = status === 'EXPIRED' || (status === 'ERROR' && Number(result.durationMs) >= 29 * 60_000);
      if (!hitLimit) throw new CursorError(502, `Cursor agent ${status.toLowerCase()}${result.error ? `: ${String(typeof result.error === 'object' ? (result.error as { message?: string }).message : result.error)}` : ''}`);
      if ((st.idle ?? 0) >= 2) {
        // An hour of work without a save: it ran out of time, so it isn't refunded.
        if (c.shared) return c.finish('failed', 'The builder worked for a long time without saving anything, so I stopped it. Try a smaller first step.', { refund: false });
        throw new CursorError(502, 'The agent worked through two whole Cursor runs without pushing anything, so Orb stopped it. Try a smaller first step, or lower effort in You → Model.');
      }
      if ((st.runs?.length ?? 0) >= MAX_RUNS) {
        if (!c.shared) throw new CursorError(502, 'This build ran for a very long time, so Orb paused it. Say “keep going” to continue.');
        // Days of work: keep what it saved.
        if (st.idle) return c.finish('failed', 'The builder ran out of time before it saved anything. Try a smaller first step.', { refund: false });
        out.say(`${spoke ? '\n' : ''}${FREE_PAUSE}`);
        c.trace.note('pause', { text: `Paused after ${MAX_RUNS} Cursor runs.` });
        return c.finish('done');
      }
      // Past Cursor's per-run limit: a follow-up run carries on.
      const followUp = CURSOR_ORB_CONTINUE;
      if (st.tokens) cursorInput(st.tokens, withLink(followUp).length);
      const next = await call<{ run?: { id?: string }; id?: string }>(apiKey, 'POST', `/v1/agents/${encodeURIComponent(st.agentId!)}/runs`, { prompt: { text: withLink(followUp) } }, c.signal, 90_000);
      const nextId = next.run?.id ?? next.id;
      if (!nextId) throw new CursorError(502, 'Cursor did not start the follow-up run');
      st.runs!.push(nextId);
      st.runIndex = st.runs!.length - 1;
      c.trace.note('run', { text: followUp, run: st.runIndex, runId: nextId, previous: { status, durationMs: result.durationMs } });
      st.lastId = null;
      st.active = false;
      out.control({ t: 'status', phase: 'thinking', text: 'Picking up where I left off…' });
      await saveState();
    }
    clearInterval(lookTimer);
    await serveLooks();

    if (out.cancelled || c.signal.aborted) {
      await cancelCursorRun(apiKey, { agentId: st.agentId!, runId: st.runs![st.runIndex!] });
      await settle();
      return c.finish('cancelled');
    }
    if (budgetStop && !done) {
      // The day's budget or the maker's credits are spent: stop the agent (its run would go on) and keep what it made.
      await cancelCursorRun(apiKey, { agentId: st.agentId!, runId: st.runs![st.runIndex!] });
      await settle();
      flushSay(true);
      c.trace.note('pause', { text: /credits/.test(budgetStop) ? "Stopped the agent: the maker's credits are used up." : "Stopped the agent: the free builder's budget for today is used up." });
      if (!st.active) return c.finish('failed', budgetStop);
      out.say(`${spoke ? '\n' : ''}${budgetStop}`);
      return c.finish('done');
    }
    if (done) {
      await settle();
      // The final message comes with the run's result too: say whatever of it never streamed (a
      // dropped or expired stream), or the person sees only "Let me look…" and the ideas.
      const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
      const unsaid = finalText
        .replace(/^\s*next ideas:.*$/gim, '')
        .replace(/^\s*own copy:.*$/gim, '')
        .split(/\n+/)
        .filter((l) => flat(l) && !flat(streamed).includes(flat(l)))
        .join('\n');
      if (unsaid) out.say(`${spoke ? '\n' : ''}${narration(unsaid)}`);
      const ideas = NEXT_IDEAS.exec(finalText)?.[1];
      if (ideas) c.meta.suggestions = ideas.split('|').map((s) => s.replace(/[<>]/g, '').trim().slice(0, 60)).filter(Boolean).slice(0, 3);
      if (c.job.mode === 'ask' && OWN_COPY.test(finalText)) c.meta.remix = true;
      return c.finish('done');
    }
    await settle();
    await saveState();
    return 'continue';
  } catch (e) {
    clearInterval(lookTimer);
    await looking.serving;
    await sync.pulling?.catch(() => undefined);
    await bill().catch((err) => console.error('[orb] charging the free builder failed', err));
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof CursorError && e.status >= 500 && !/agent (error|failed|cancel)|two whole|very long/i.test(msg)) {
      // A hiccup on Cursor's side: the next tick tries again.
      console.error('[orb] cursor tick failed', msg);
      c.trace.error({ message: msg, retry: true, status: e.status });
      await saveState().catch(() => undefined);
      return 'continue';
    }
    if (c.shared) {
      const f = freeFailure(e);
      if (f.record) await recordError(db, { kind: 'builder', message: `Cursor builds refused: ${msg}` }).catch(() => undefined);
      return c.finish('failed', f.message);
    }
    return c.finish('failed', e instanceof CursorError ? describeCursorError(e).message : msg);
  } finally {
    clearInterval(lookTimer);
  }
}

/** A Cursor tool call → a step in the chat (file changes) or a "thinking" line (reading, saving). */
function toolEvent(c: TickCtx, d: Record<string, unknown>, runIndex: number, onPush: () => void): void {
  const name = String(d.name ?? '');
  const status = String(d.status ?? '');
  const id = d.callId ? `r${runIndex}:${String(d.callId)}` : '';
  const args = (d.args && typeof d.args === 'object' ? d.args : undefined) as Record<string, unknown> | undefined;
  if (!id || !args) return;
  if (name === 'run_terminal_cmd' || /terminal|shell|command/i.test(name)) {
    const cmd = String(args.command ?? '');
    if (/git\s+push|\.orb\/save\b/.test(cmd)) {
      if (status === 'running') c.out.control({ t: 'status', phase: 'thinking', text: 'Saving to the world…' });
      else if (status === 'completed') onPush();
    }
    return;
  }
  const path = toolPath(args);
  if (/edit|write|replace|create|delete|patch|apply/i.test(name) && !/read/i.test(name)) {
    if (!path) return;
    const verb = /delete/i.test(name) ? 'Removing' : /write|create/i.test(name) ? 'Writing' : 'Changing';
    const st = status === 'completed' ? 'done' : status === 'running' ? 'pending' : 'failed';
    c.out.endSay();
    c.out.control({ t: 'step', id, kind: verb === 'Writing' ? 'write' : 'edit', label: `${verb} ${basename(path)}`, status: st });
    return;
  }
  if (status === 'running' && /read|search|grep|list|find/i.test(name)) {
    const text = path.startsWith(`${SEEN_DIR}/`) ? 'Looking closely…' : /read/i.test(name) && path ? `Reading ${basename(path)}…` : 'Looking around…';
    c.out.control({ t: 'status', phase: 'thinking', text });
  }
}
