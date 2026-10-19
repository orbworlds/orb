// A Cursor agent's file edits, as they happen: its stream reports each finished edit with the
// file's new contents, or a unified diff of the change. Applying that to Orb's copy of the files
// shows the edit in the world at once instead of at the agent's next save (./cursor.ts), and the
// save stays the authority for anything else the agent did (shell commands, deletes, moves).

/** One finished edit from the stream: the file and its new contents (or the diff that makes them). */
export interface StreamedEdit {
  path: string;
  after?: string;
  diff?: string;
}

/**
 * Apply a unified diff ("@@ -a,b +c,d @@" hunks) to `before`; null when it doesn't fit. Lines are
 * compared without their endings (Cursor's diffs don't mark a missing last newline); a file whose
 * end the diff rewrites ends with a newline, unless the diff says it doesn't.
 */
export function applyUnifiedDiff(before: string, diff: string): string | null {
  const endsWithNewline = before.endsWith('\n');
  const old = before === '' ? [] : (endsWithNewline ? before.slice(0, -1) : before).split('\n');
  const out: string[] = [];
  let at = 0; // next line of `old` to copy
  let hunks = 0;
  let lastNewline = true;
  const lines = diff.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(lines[i]);
    if (!m) continue;
    hunks++;
    const start = Number(m[1]) - (m[2] === '0' ? 0 : 1);
    if (start < at || start > old.length) return null;
    if (m[1] === '0' && m[2] === '0' && old.length) return null; // a diff that makes the file, for one that exists
    out.push(...old.slice(at, start));
    at = start;
    let prev = '';
    for (i++; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const line = lines[i];
      if (line === '' && i === lines.length - 1) break; // the diff's own last newline
      if (line.startsWith('\\')) {
        if (prev === '+') lastNewline = false; // "\ No newline at end of file" after the new last line
        continue;
      }
      const op = line === '' ? ' ' : line[0];
      prev = op;
      if (op === '+') out.push(line.slice(1));
      else if (op === '-' || op === ' ') {
        if (old[at] !== line.slice(1)) return null;
        if (op === ' ') out.push(line.slice(1));
        at++;
      } else return null;
    }
    i--;
  }
  if (!hunks) return null;
  const tail = old.slice(at);
  const result = [...out, ...tail];
  if (!result.length) return '';
  return result.join('\n') + ((tail.length ? endsWithNewline : lastNewline) ? '\n' : '');
}

const workspacePath = (p: unknown) => (typeof p === 'string' ? /^\/?(?:agent|workspace)\/(.+)$/.exec(p)?.[1] ?? (p.startsWith('/') ? null : p.replace(/^\.\//, '')) : null);

/** A finished edit in a stream event (Cursor's `tool_call` or `interaction_update`), if the event is one. */
export function streamedEdit(event: string, d: Record<string, unknown>): StreamedEdit | null {
  if (event === 'tool_call') {
    if (d.status !== 'completed' || !/edit|write/i.test(String(d.name ?? '')) || /read/i.test(String(d.name ?? ''))) return null;
    const args = (d.args ?? {}) as Record<string, unknown>;
    const ok = ((d.result as { success?: Record<string, unknown> } | undefined)?.success ?? {}) as Record<string, unknown>;
    const path = workspacePath(ok.path ?? args.path ?? args.target_file);
    if (!path) return null;
    if (typeof ok.afterFullFileContent === 'string') return { path, after: ok.afterFullFileContent };
    return typeof ok.diffString === 'string' ? { path, diff: ok.diffString } : null;
  }
  if (event === 'interaction_update' && d.type === 'tool-call-completed') {
    const call = (d.toolCall ?? {}) as { type?: string; args?: Record<string, unknown>; result?: { status?: string; value?: Record<string, unknown> } };
    if (call.type !== 'edit' || call.result?.status !== 'success') return null;
    const path = workspacePath(call.args?.path);
    const diff = call.result.value?.diffString;
    return path && typeof diff === 'string' ? { path, diff } : null;
  }
  return null;
}
