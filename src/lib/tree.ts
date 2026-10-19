// Multi-file worlds run their index.html in the world frame (srcdoc); a <base> tag pointing at
// /api/tree/<sha>/ makes its relative modules, styles and assets load from the world's files.
// The tag goes on an existing line (no newline), so the page's line numbers stay the same.

import { SITE } from './site';

const MARK = 'data-orb-base';
const BASE_RE = /<base data-orb-base href="[^"]*">/;

function origin(): string {
  return typeof location !== 'undefined' ? location.origin : SITE;
}

export const treeUrl = (tree: string) => `${origin()}/api/tree/${tree}/`;

/** The page with the base tag for `tree` (unchanged when there is no tree or it already has one). */
export function withTree(html: string, tree: string | null | undefined): string {
  if (!tree || !html || html.includes(MARK)) return html;
  const tag = `<base ${MARK} href="${treeUrl(tree)}">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const top = /^(﻿?\s*<!doctype[^>]*>)?(\s*<html(\s[^>]*)?>)?/i.exec(html);
  const at = top ? top[0].length : 0;
  return html.slice(0, at) + tag + html.slice(at);
}

/** The page as the person wrote it (for the code view). */
export function withoutTree(html: string): string {
  return html.includes(MARK) ? html.replace(BASE_RE, '') : html;
}

/** Runtime error locations point into the world's files: show them as plain paths. */
export function treePath(url: string): string {
  const m = /\/api\/tree\/[a-f0-9]{64}\/(.*)$/.exec(url);
  return m ? m[1] : url;
}
