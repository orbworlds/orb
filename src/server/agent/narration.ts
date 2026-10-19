// What a Cursor agent says, as words for the person in Orb's chat (see ./cursor.ts).

/**
 * Cursor's agents report what they couldn't verify ("I haven't opened it in a browser to test
 * it", "It's saved, so…") and the setup of their folder ("I'll bring the world's files in")
 * even when asked not to; Orb runs the world for the person and reports its problems back
 * itself, so those sentences are left out of the chat (traces keep them).
 */
const CHECK_TALK = [
  /[^.!?\n]*\b(?:bring|bringing|get|getting|grab|grabbing|download|downloading|fetch|fetching|pull|pulling|load|loading|copy|copying|unpack|unpacking)\b[^.!?\n]*\bfiles?\b[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\b(?:I|we)\s+(?:haven['’]?t|have not|couldn['’]?t|could not|didn['’]?t|did not|can['’]?t|cannot|wasn['’]?t able to|was not able to)\b[^.!?\n]*?\b(?:test|check|tr(?:y|ie)|see|seen|open|run|ran|play|view|look)\w*\s+(?:it|the world|this|that|how|whether|if)\b[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\bbrowser\b[^.!?\n]*[.!?]?/gi,
  /[^.!?\n]*\b(?:it['’]?s|it is|it has been|the world is)\s+saved\b[^.!?\n]*[.!?]?|[^.!?\n]*\bI(?:['’]ve| have)?\s+saved\s+(?:it|the world|this|everything)\b[^.!?\n]*[.!?]?/gi,
];

export function withoutChecks(text: string): string {
  let out = text;
  for (const re of CHECK_TALK) out = out.replace(re, '');
  return out.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '').replace(/^\n+/, '');
}

/** Words for the person, from the agent's message: no markdown, and no talk about checks. */
export function narration(text: string): string {
  return withoutChecks(
    text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/^#+\s*/gm, ''),
  );
}
