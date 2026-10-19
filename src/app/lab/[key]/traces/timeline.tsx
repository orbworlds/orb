import type { ReactNode } from 'react';
import { blobSha, type Tokens, type TraceEvent, type TraceKind, type TraceStatus } from '@/server/traces';
import { BlobLink, clock, duration, Fields, Fold, isLong, num, Pre, Shot, sizeOf, Status, tokenLine, when } from './ui';

// A trace's timeline (its lab page): each event of src/server/traces.ts laid out to read. A step
// shows the model's thinking, words and tool calls, each call with its result; a look shows what
// the agent did in the world and the screenshots it got back.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const nr = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** The non-empty strings among `xs`, joined (so `count > 0 && "…"` parts drop out). */
const dots = (...xs: unknown[]) => xs.filter((x): x is string => typeof x === 'string' && x !== '').join(' · ');
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const without = (o: Obj, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !keys.includes(k) && v !== undefined));
const preview = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+/g, ' ').trim()}…` : s.replace(/\s+/g, ' ').trim());

/** A saved version, running on its own (its files, sandboxed, from src/app/api/tree). */
const playUrl = (tree: string) => `/api/tree/${tree}/index.html`;

const EVENT_CARD = 'min-w-0 flex-1 rounded-[16px] bg-[var(--glass-bg-strong)] px-4 py-3 shadow-[0_1px_2px_rgba(16,16,40,.05),0_6px_18px_-12px_rgba(16,16,40,.2),inset_0_0_0_1px_var(--glass-hairline)]';
const TOOL_BOX = 'mt-2 min-w-0 rounded-[12px] bg-[var(--bubble)] px-3 py-2';
const BAD = 'text-[var(--bad)]';

function Head({ title, tone = 'text-ink', children }: { title: ReactNode; tone?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className={`text-[14px] font-semibold ${tone}`}>{title}</span>
      {children ? <span className="text-[12px] text-ink-2 tabular-nums">{children}</span> : null}
    </div>
  );
}

// -- message parts ------------------------------------------------------------------------------

function Words({ text }: { text: string }) {
  if (!text.trim()) return null;
  if (text.length <= 1500 && text.split('\n').length <= 30) return <p className="mt-1.5 text-[14px] leading-relaxed break-words whitespace-pre-wrap text-ink">{text}</p>;
  return (
    <Fold summary={`${preview(text, 140)} · ${sizeOf(text)}`}>
      <Pre>{text}</Pre>
    </Fold>
  );
}

function Thinking({ text }: { text: string }) {
  if (!text.trim()) return null;
  const body = 'text-[13px] leading-relaxed break-words whitespace-pre-wrap text-ink-2 italic';
  if (text.length <= 320) {
    return (
      <p className={`mt-1.5 ${body}`}>
        <span className="font-medium text-ink-3 not-italic">Thinking · </span>
        {text}
      </p>
    );
  }
  return (
    <Fold
      summary={
        <>
          <span className="font-medium">Thinking</span> · {sizeOf(text)} <span className="text-ink-3 italic">— {preview(text, 110)}</span>
        </>
      }
    >
      <p className={`mt-1.5 max-h-[480px] overflow-auto rounded-[10px] bg-[var(--field-bg)] px-3 py-2.5 ${body}`}>{text}</p>
    </Fold>
  );
}

function Result({ text, bad }: { text: string; bad?: boolean }) {
  const tone = bad ? BAD : 'text-ink-2';
  if (!isLong(text, 400)) return <pre className={`mt-0.5 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap ${tone}`}>{text}</pre>;
  return (
    <Fold summary={`${bad ? 'Error' : 'Result'} · ${sizeOf(text)} — ${preview(text, 90)}`}>
      <Pre tone={tone}>{text}</Pre>
    </Fold>
  );
}

/** The stored image a part shows: an image part, or a file part of an image type. */
function imageOf(p: Obj): string | null {
  const type = str(p.mediaType) ?? str(p.mimeType) ?? '';
  if (p.type !== 'image' && p.type !== 'image-data' && !type.startsWith('image/')) return null;
  for (const v of [p.image, p.data, obj(p.data).data, p.url]) {
    const sha = blobSha(v);
    if (sha) return sha;
  }
  return null;
}

function ToolResult({ o, lab, shown }: { o: Obj; lab: string; shown?: Set<string> }) {
  const type = str(o.type);
  if (type === 'content') return <Parts parts={arr(o.value).map(obj)} lab={lab} shown={shown} result />;
  if (type === 'execution-denied') return <p className={`text-[12.5px] ${BAD}`}>Not allowed{str(o.reason) ? `: ${str(o.reason)}` : ''}</p>;
  const bad = type === 'error-text' || type === 'error-json';
  if (typeof o.value === 'string') return <Result text={o.value} bad={bad} />;
  return (
    <div className={bad ? BAD : ''}>
      <Fields o={o.value} lab={lab} />
    </div>
  );
}

function ToolCall({ call, result, lab, shown }: { call: Obj | null; result?: Obj; lab: string; shown?: Set<string> }) {
  const out = result ? obj(result.output) : null;
  const type = str(out?.type) ?? '';
  const failed = type.startsWith('error') || type === 'execution-denied';
  return (
    <div className={TOOL_BOX}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-[12.5px] font-semibold text-ink">{str(call?.toolName) ?? str(result?.toolName) ?? 'tool'}</span>
        {!call && <span className="text-[12px] text-ink-3">result</span>}
        {failed && <span className={`text-[12px] font-medium ${BAD}`}>failed</span>}
        {!out && <span className="text-[12px] text-ink-3">no result in this step</span>}
      </div>
      {call && call.input !== undefined && (
        <div className="mt-1">
          <Fields o={call.input} lab={lab} />
        </div>
      )}
      {out && (
        <div className={call ? 'mt-2 border-t border-[var(--ink-5)] pt-1.5' : 'mt-1'}>
          <ToolResult o={out} lab={lab} shown={shown} />
        </div>
      )}
    </div>
  );
}

function Gallery({ shots, lab, small }: { shots: Array<{ sha: string; label?: string }>; lab: string; small?: boolean }) {
  return (
    <div className="mt-2 flex flex-wrap items-start gap-3">
      {shots.map((s, i) => (
        <Shot key={`${s.sha}-${i}`} lab={lab} sha={s.sha} label={s.label} small={small} />
      ))}
    </div>
  );
}

/**
 * Parts in order: images side by side (with the captions looks put before them), each tool call
 * with its result. Images in `shown` (on a look's card) are only counted.
 */
function Parts({ parts, lab, results, result, shown }: { parts: Obj[]; lab: string; results?: Map<string, Obj>; result?: boolean; shown?: Set<string> }) {
  const out: ReactNode[] = [];
  let shots: Array<{ sha: string; label?: string }> = [];
  let onLook = 0;
  let caption: string | undefined;
  const flush = () => {
    if (shots.length) out.push(<Gallery key={`g${out.length}`} shots={shots} lab={lab} small={result} />);
    if (onLook)
      out.push(
        <p key={`l${out.length}`} className="mt-1 text-[12px] text-ink-3">
          + {plural(onLook, 'screenshot')}, shown with the look below
        </p>,
      );
    shots = [];
    onLook = 0;
  };
  parts.forEach((p, i) => {
    const sha = imageOf(p);
    if (sha) {
      if (shown?.has(sha)) onLook++;
      else shots.push({ sha, label: caption });
      caption = undefined;
      return;
    }
    const label = p.type === 'text' ? /^Screenshot "([^"]{1,80})"/.exec(str(p.text) ?? '')?.[1] : undefined;
    if (label && parts[i + 1] && imageOf(parts[i + 1])) {
      caption = label;
      return;
    }
    flush();
    if (p.type === 'text') out.push(result ? <Result key={i} text={str(p.text) ?? ''} /> : <Words key={i} text={str(p.text) ?? ''} />);
    else if (p.type === 'reasoning') out.push(<Thinking key={i} text={str(p.text) ?? ''} />);
    else if (p.type === 'tool-call') out.push(<ToolCall key={i} call={p} result={results?.get(String(p.toolCallId))} lab={lab} shown={shown} />);
    else if (p.type === 'tool-result') out.push(<ToolCall key={i} call={null} result={p} lab={lab} shown={shown} />);
    else
      out.push(
        <div key={i} className={TOOL_BOX}>
          <Fields o={p} lab={lab} />
        </div>,
      );
  });
  flush();
  return <>{out}</>;
}

const ROLES: Record<string, string> = { user: 'Person', assistant: 'AI', system: 'System', tool: 'Tool results' };
/** A Cursor job's one message is Orb's whole instruction (src/server/agent/cursor.ts). */
const CURSOR_ROLES = { ...ROLES, user: 'Prompt for Cursor' };

/** Messages in order, each tool call shown with its result (from the tool message after it). */
function Conversation({ messages, lab, roles, shown }: { messages: unknown[]; lab: string; roles?: Record<string, string>; shown?: Set<string> }) {
  const ms = messages.map(obj);
  const results = new Map<string, Obj>();
  const called = new Set<string>();
  for (const m of ms) {
    for (const p of arr(m.content).map(obj)) {
      if (p.type === 'tool-call') called.add(String(p.toolCallId));
      else if (p.type === 'tool-result') results.set(String(p.toolCallId), p);
    }
  }
  return (
    <>
      {ms.map((m, i) => {
        const role = str(m.role) ?? '?';
        const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : arr(m.content).map(obj).filter((p) => !(p.type === 'tool-result' && called.has(String(p.toolCallId))));
        if (!parts.length) return null;
        return (
          <div key={i} className={roles ? 'mt-3' : ''}>
            {roles ? <div className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">{roles[role] ?? role}</div> : role === 'user' && <div className="mt-2 text-[12px] text-ink-3">Then shown to the model:</div>}
            <Parts parts={parts} lab={lab} results={results} shown={shown} />
          </div>
        );
      })}
    </>
  );
}

function Files({ files, tree, lab, label }: { files: Obj; tree?: string; lab: string; label: string }) {
  const list = Object.entries(files)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .sort(([a], [b]) => a.localeCompare(b));
  if (!list.length) return null;
  return (
    <Fold summary={`${label} · ${plural(list.length, 'file')}`}>
      <div className="mt-1.5 flex flex-col gap-1 rounded-[10px] bg-[var(--field-bg)] px-3 py-2">
        {tree && (
          <a href={playUrl(tree)} target="_blank" rel="noreferrer" className="text-[12.5px] font-medium text-ink underline decoration-[var(--ink-4)] underline-offset-2">
            Play this version
          </a>
        )}
        {list.map(([path, sha]) => (
          <BlobLink key={path} lab={lab} sha={sha}>
            {path}
          </BlobLink>
        ))}
      </div>
    </Fold>
  );
}

// -- events -------------------------------------------------------------------------------------

function Input({ e, lab, system, kind }: { e: TraceEvent; lab: string; system: string | null; kind: TraceKind }) {
  const p = obj(e.payload);
  const messages = arr(p.messages);
  const files = obj(p.files);
  const rest = without(p, ['system', 'messages', 'tree', 'files']);
  const earlier = messages.slice(0, -1);
  const roles = kind === 'cursor' ? CURSOR_ROLES : ROLES;
  return (
    <>
      <Head title="Input">{dots(messages.length > 0 && plural(messages.length, 'message'), Object.keys(files).length > 0 && plural(Object.keys(files).length, 'file'), nr(e.summary.images) && plural(nr(e.summary.images)!, 'image'))}</Head>
      {system && (
        <Fold summary={`System prompt · ${sizeOf(system)}`}>
          <Pre>{system}</Pre>
        </Fold>
      )}
      {earlier.length > 0 && (
        <Fold summary={`Earlier in the chat · ${plural(earlier.length, 'message')}`}>
          <Conversation messages={earlier} lab={lab} roles={roles} />
        </Fold>
      )}
      <Conversation messages={messages.slice(-1)} lab={lab} roles={roles} />
      <Files files={files} tree={str(p.tree)} lab={lab} label="The world’s files at the start" />
      {Object.keys(rest).length > 0 && (
        <div className="mt-2">
          <Fields o={rest} lab={lab} />
        </div>
      )}
    </>
  );
}

function Step({ e, lab, model, shown }: { e: TraceEvent; lab: string; model: string | null; shown: Set<string> }) {
  const s = e.summary;
  const p = obj(e.payload);
  if (!Array.isArray(p.messages)) return <CursorStep e={e} lab={lab} />;
  const finish = str(s.finish);
  return (
    <>
      <Head title={`Step ${nr(s.step) ?? ''}`}>
        {dots(duration(nr(s.ms)), s.usage ? tokenLine(obj(s.usage) as Partial<Tokens>) : null, finish && finish !== 'tool-calls' && `finished: ${finish}`, str(s.model) && s.model !== model && str(s.model))}
      </Head>
      <Conversation messages={p.messages} lab={lab} shown={shown} />
    </>
  );
}

function CursorStep({ e, lab }: { e: TraceEvent; lab: string }) {
  const p = obj(e.payload);
  const tools = arr(p.tools).map(obj);
  const other = arr(p.events);
  return (
    <>
      <Head title={`Cursor run ${(nr(p.run) ?? 0) + 1}`}>{dots(duration(nr(p.ms)), plural(tools.length, 'tool call'), str(e.summary.status)?.toLowerCase())}</Head>
      <Thinking text={str(p.thinking) ?? ''} />
      <Words text={str(p.text) ?? ''} />
      {tools.map((t, i) => {
        const status = str(t.status);
        return (
          <div key={i} className={TOOL_BOX}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-[12.5px] font-semibold text-ink">{str(t.name) ?? 'tool'}</span>
              {status && <span className={`text-[12px] ${status === 'completed' ? 'text-ink-3' : status === 'running' ? 'text-ink-2' : BAD}`}>{status}</span>}
            </div>
            <div className="mt-1">
              <Fields o={t.args} lab={lab} />
              <Fields o={without(t, ['name', 'status', 'args', 'callId'])} lab={lab} />
            </div>
          </div>
        );
      })}
      {other.length > 0 && (
        <Fold summary={`Other events · ${num(other.length)}`}>
          <Pre>{JSON.stringify(other, null, 2)}</Pre>
        </Fold>
      )}
    </>
  );
}

const LOOKED: Record<string, string> = { seen: 'saw the world', unavailable: 'couldn’t look', timeout: 'no answer in time' };

/** A look's stored screenshots, each labelled with when it was taken. */
function lookShots(e: TraceEvent): Array<{ sha: string; label: string }> {
  return arr(obj(obj(obj(e.payload).answer).result).shots).flatMap((v) => {
    const sh = obj(v);
    const sha = blobSha(sh.dataUrl);
    return sha ? [{ sha, label: dots(str(sh.label), nr(sh.t) !== undefined && `${(nr(sh.t)! / 1000).toFixed(1)} s`) }] : [];
  });
}

function Look({ e, lab }: { e: TraceEvent; lab: string }) {
  const s = e.summary;
  const p = obj(e.payload);
  const answer = obj(p.answer);
  const r = obj(answer.result);
  const shots = lookShots(e);
  const errors = arr(r.errors).map(obj);
  const logs = arr(r.logs).map(obj);
  const evals = arr(r.evals).map(obj);
  const notes = arr(r.notes).filter((n): n is string => typeof n === 'string');
  const actions = arr(p.actions);
  return (
    <>
      <Head title="Look">
        {dots(LOOKED[String(s.outcome)], duration(nr(s.ms)), shots.length > 0 && plural(shots.length, 'screenshot'), nr(r.fps) !== undefined && `${Math.round(nr(r.fps)!)} fps`, errors.length > 0 && plural(errors.length, 'error'), nr(p.skipped) && `${num(nr(p.skipped)!)} actions skipped`)}
      </Head>
      {str(answer.unavailable) && <p className="mt-1 text-[13px] text-[var(--warn-ink)]">{str(answer.unavailable)}</p>}
      {actions.length > 0 && (
        <Fold summary={`What it did · ${plural(actions.length, 'action')}`}>
          <Pre>{JSON.stringify(actions, null, 2)}</Pre>
        </Fold>
      )}
      {shots.length > 0 && <Gallery lab={lab} shots={shots} />}
      {errors.length > 0 && (
        <Fold summary={`Errors in the world · ${num(errors.length)}`} open={errors.length <= 3}>
          <Pre tone={BAD}>{errors.map((x) => `${str(x.message) ?? JSON.stringify(x)}${str(x.source) ? ` (${x.source}${nr(x.line) ? `:${x.line}` : ''})` : ''}`).join('\n')}</Pre>
        </Fold>
      )}
      {logs.length > 0 && (
        <Fold summary={`Console · ${plural(logs.length, 'line')}`}>
          <Pre>{logs.map((l) => `${str(l.level) ?? 'log'}  ${str(l.text) ?? ''}`).join('\n')}</Pre>
        </Fold>
      )}
      {evals.length > 0 && (
        <Fold summary={`Checked in the page · ${num(evals.length)}`}>
          <Pre>{evals.map((x) => `> ${str(x.js) ?? ''}\n${x.error ? '✗ ' : ''}${str(x.result) ?? ''}`).join('\n\n')}</Pre>
        </Fold>
      )}
      {notes.length > 0 && <p className="mt-1.5 text-[12.5px] text-ink-2">{notes.join(' · ')}</p>}
      {Object.keys(r).length > 0 && (
        <Fold summary="Everything else it reported">
          <Pre>{JSON.stringify(without(r, ['shots', 'errors', 'logs', 'evals', 'notes']), null, 2)}</Pre>
        </Fold>
      )}
    </>
  );
}

function OutputEvent({ e }: { e: TraceEvent }) {
  const p = obj(e.payload);
  const text = str(p.text) ?? '';
  const finish = str(p.finishReason);
  return (
    <>
      <Head title="Output">{dots(`${num(text.length)} characters`, duration(nr(p.ms)), e.summary.usage ? tokenLine(obj(e.summary.usage) as Partial<Tokens>) : null, finish && finish !== 'stop' && `finished: ${finish}`)}</Head>
      {p.resume ? <p className="mt-1 text-[12.5px] text-ink-2">The page picked the rest up with a resume request (the next events).</p> : null}
      {text ? (
        <Fold summary={`Raw output · ${sizeOf(text)}`} open={text.length <= 20_000}>
          <Pre>{text}</Pre>
        </Fold>
      ) : (
        <p className="mt-1 text-[13px] text-ink-3">Nothing came out.</p>
      )}
    </>
  );
}

function End({ e, lab }: { e: TraceEvent; lab: string }) {
  const p = obj(e.payload);
  const suggestions = arr(p.suggestions).filter((s): s is string => typeof s === 'string');
  const rest = without(p, ['status', 'error', 'tree', 'files', 'name', 'suggestions']);
  return (
    <>
      <Head title={<Status status={(str(p.status) ?? 'done') as TraceStatus} />}>{str(p.name) && `named it “${str(p.name)}”`}</Head>
      {str(p.error) && <p className={`mt-1 text-[13.5px] break-words ${BAD}`}>{str(p.error)}</p>}
      {suggestions.length > 0 && <p className="mt-1 text-[12.5px] text-ink-2">Ideas for next: {suggestions.join(' · ')}</p>}
      <Files files={obj(p.files)} tree={str(p.tree)} lab={lab} label="The world’s files at the end" />
      {Object.keys(rest).length > 0 && (
        <div className="mt-2">
          <Fields o={rest} lab={lab} />
        </div>
      )}
    </>
  );
}

const NOTES: Record<string, string> = {
  nudge: 'Nudged the model',
  pause: 'Paused',
  deadline: 'Out of time for this run',
  tick: 'Carried on in the next run',
  run: 'Cursor run started',
  disconnected: 'The page stopped listening',
};

function Note({ e, lab }: { e: TraceEvent; lab: string }) {
  const p = obj(e.payload);
  const kind = str(p.kind) ?? str(e.summary.kind) ?? 'note';
  const text = str(p.text);
  const run = kind === 'run' ? nr(p.run) : undefined;
  const rest = without(p, ['kind', 'text', ...(run !== undefined ? ['run'] : [])]);
  return (
    <>
      <span className="font-medium text-ink">{run !== undefined ? `Cursor run ${run + 1} started` : (NOTES[kind] ?? kind)}</span>
      {text && !isLong(text, 200) && <span> — {text}</span>}
      {text && isLong(text, 200) && (
        <Fold summary={`What it was told · ${sizeOf(text)}`}>
          <Pre>{text}</Pre>
        </Fold>
      )}
      {Object.keys(rest).length > 0 && (
        <div className="mt-0.5">
          <Fields o={rest} lab={lab} />
        </div>
      )}
    </>
  );
}

function Line({ e, lab }: { e: TraceEvent; lab: string }) {
  const s = e.summary;
  if (e.type === 'commit') {
    const tree = str(s.tree);
    return (
      <>
        <span className="font-medium text-[var(--ok)]">Saved version {nr(s.version) ?? '?'}</span>
        {str(s.name) && <span> — “{str(s.name)}”</span>}
        {tree && (
          <>
            {' · '}
            <a href={playUrl(tree)} target="_blank" rel="noreferrer" className="text-ink underline decoration-[var(--ink-4)] underline-offset-2">
              play it
            </a>
          </>
        )}
      </>
    );
  }
  if (e.type === 'retry') {
    return (
      <>
        <span className="font-medium text-[var(--warn-ink)]">Retried</span>
        <span> — {dots(str(s.message), nr(s.status) && `HTTP ${s.status}`, nr(s.waitMs) && `waited ${duration(nr(s.waitMs))}`, nr(s.failures) && `failure ${s.failures}`, nr(s.step) && `step ${s.step}`)}</span>
      </>
    );
  }
  if (e.type === 'compact') {
    const [from, to] = arr(s.chars).map(Number);
    const [mFrom, mTo] = arr(s.messages).map(Number);
    return (
      <>
        <span className="font-medium text-ink">Trimmed the conversation to fit</span>
        <span>
          {' '}
          — {num(from)} → {num(to)} characters, {num(mFrom)} → {num(mTo)} messages
        </span>
      </>
    );
  }
  return <Note e={e} lab={lab} />;
}

function ErrorEvent({ e }: { e: TraceEvent }) {
  const p = obj(e.payload);
  return (
    <>
      <Head title="Error" tone={BAD}>
        {dots(nr(p.status) && `HTTP ${p.status}`, nr(p.step) && `step ${p.step}`, nr(p.ms) !== undefined && duration(nr(p.ms)), nr(p.failures) && `failure ${p.failures}`)}
      </Head>
      <p className={`mt-1 text-[13.5px] break-words whitespace-pre-wrap ${BAD}`}>{str(p.message) ?? str(e.summary.message) ?? 'Something went wrong.'}</p>
    </>
  );
}

function Other({ e, lab }: { e: TraceEvent; lab: string }) {
  return (
    <>
      <Head title={e.type} />
      <Fields o={e.summary} lab={lab} />
      {e.payload != null && (
        <Fold summary={`Payload · ${num(e.size)} bytes`}>
          <Pre>{JSON.stringify(e.payload, null, 2)}</Pre>
        </Fold>
      )}
    </>
  );
}

const CARDS = new Set(['input', 'step', 'look', 'output', 'end', 'error']);
const LINES = new Set(['commit', 'retry', 'compact', 'note']);

interface View {
  lab: string;
  kind: TraceKind;
  system: string | null;
  model: string | null;
}

function EventRow({ e, at, t0, view, shown }: { e: TraceEvent; at: number; t0: number; view: View; shown: Set<string> }) {
  const { lab, kind, system, model } = view;
  const card = !LINES.has(e.type);
  const body =
    e.type === 'input' ? (
      <Input e={e} lab={lab} system={system} kind={kind} />
    ) : e.type === 'step' ? (
      <Step e={e} lab={lab} model={model} shown={shown} />
    ) : e.type === 'look' ? (
      <Look e={e} lab={lab} />
    ) : e.type === 'output' ? (
      <OutputEvent e={e} />
    ) : e.type === 'end' ? (
      <End e={e} lab={lab} />
    ) : e.type === 'error' ? (
      <ErrorEvent e={e} />
    ) : LINES.has(e.type) ? (
      <Line e={e} lab={lab} />
    ) : (
      <Other e={e} lab={lab} />
    );
  return (
    <li id={`e${e.seq}`} className="flex scroll-mt-6 items-start gap-2.5 sm:gap-3">
      <a href={`#e${e.seq}`} title={when(new Date(at).toISOString())} className={`w-[44px] shrink-0 text-right text-[12px] text-ink-3 tabular-nums hover:text-ink sm:w-[52px] ${card ? 'pt-[13px]' : 'pt-[2px]'}`}>
        {clock(at - t0)}
      </a>
      {card ? <div className={EVENT_CARD}>{body}</div> : <div className="min-w-0 flex-1 py-0.5 text-[13px] break-words text-ink-2">{body}</div>}
    </li>
  );
}

const MARKS: Record<string, string> = {
  look: 'bg-iris-1/15 text-ink',
  commit: 'bg-[color-mix(in_oklab,var(--ok)_16%,transparent)] text-ink',
  retry: 'bg-[var(--warn-bg)] text-[var(--warn-ink)]',
  error: 'bg-[color-mix(in_oklab,var(--bad)_16%,transparent)] text-[var(--bad)]',
};

function mark(e: TraceEvent): string {
  const s = e.summary;
  if (e.type === 'step') return nr(s.step) !== undefined ? String(s.step) : `run ${(nr(s.run) ?? 0) + 1}`;
  if (e.type === 'commit') return `v${nr(s.version) ?? '?'}`;
  if (e.type === 'end') return str(s.status) ?? 'end';
  return e.type;
}

/** The whole trace on a line or two, to jump to a step, a look or an error. */
function Overview({ events }: { events: TraceEvent[] }) {
  const marks = events.filter((e) => CARDS.has(e.type) || e.type === 'commit' || e.type === 'retry');
  if (marks.length < 8) return null;
  return (
    <nav aria-label="Jump to" className="mt-4 flex flex-wrap gap-1">
      {marks.map((e) => (
        <a key={e.seq} href={`#e${e.seq}`} className={`rounded-[7px] px-1.5 py-0.5 text-[11.5px] tabular-nums hover:shadow-[inset_0_0_0_1px_var(--ink-4)] ${MARKS[e.type] ?? 'bg-[var(--chip-bg)] text-ink-2 shadow-[inset_0_0_0_1px_var(--ink-5)]'}`}>
          {mark(e)}
        </a>
      ))}
    </nav>
  );
}

// Steps, looks and outputs are recorded when they end: they go where they began (so a look comes
// right after the step that asked for it).
const TIMED = new Set(['step', 'look', 'output', 'retry', 'error']);
const began = (e: TraceEvent) => Date.parse(e.at) - (TIMED.has(e.type) ? (nr(e.summary.ms) ?? 0) : 0);

export function Timeline({ events, startedAt, ...view }: View & { events: TraceEvent[]; startedAt: string }) {
  const t0 = Date.parse(startedAt);
  const ordered = events.map((e) => ({ e, at: began(e) })).sort((a, b) => a.at - b.at || a.e.seq - b.e.seq);
  const shown = new Set(events.filter((e) => e.type === 'look').flatMap((e) => lookShots(e).map((s) => s.sha)));
  return (
    <>
      <Overview events={ordered.map((x) => x.e)} />
      <ol className="mt-4 flex flex-col gap-2.5">
        {ordered.map(({ e, at }) => (
          <EventRow key={e.seq} e={e} at={at} t0={t0} view={view} shown={shown} />
        ))}
      </ol>
    </>
  );
}
