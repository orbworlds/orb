// What the lab's downloads answer with: a plain-text error, or JSON lines streamed as they're read.

const NO_STORE = { 'cache-control': 'no-store' };

export const plain = (status: number, text: string) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE } });

/** Each line from `lines` as it comes (`what` names it in the log when reading fails). */
export function ndjson(lines: AsyncGenerator<string>, what: string, headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const next = await lines.next();
        if (next.done) c.close();
        else c.enqueue(enc.encode(next.value));
      } catch (e) {
        console.error(`[orb] ${what} failed`, e);
        c.error(e);
      }
    },
    async cancel() {
      await lines.return(undefined);
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', ...NO_STORE, 'x-robots-tag': 'noindex', ...headers } });
}
