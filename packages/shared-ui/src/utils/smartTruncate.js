function smartTruncate(text, maxChars = 2000, headLines = 30, tailLines = 30) {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  if (lines.length <= headLines + tailLines) return text;
  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  const omitted = lines.length - headLines - tailLines;
  return [...head, `\n--- (${omitted} lines omitted) ---\n`, ...tail].join('\n');
}

/**
 * Truncate a terminal buffer snapshot.
 *
 * Command output is read head-and-tail, but a terminal buffer is read to answer
 * "what is on screen right now" — the head is stale scrollback and the tail is
 * the answer. So this keeps the end and drops the beginning, and it gets a much
 * larger budget than smartTruncate's 2000 chars: a screenful of a TUI or a build
 * log blows straight past that, and a snapshot cut down to 30 lines is what
 * makes the assistant look like it cannot see the terminal at all.
 */
function truncateTerminalBuffer(text, maxChars = 12000, maxLines = 300) {
  if (!text) return '';
  const lines = text.split('\n');
  let kept = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  let out = kept.join('\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  if (out.length < text.length) {
    return `--- (earlier terminal output omitted) ---\n${out}`;
  }
  return out;
}

/**
 * A terminal snapshot from the host, or '' when there is no terminal to read.
 *
 * Hosts answer with a parenthesised sentinel ("(No terminal connected)") rather
 * than throwing. That reads fine as a tool result, but as ambient chat context
 * it would be indistinguishable from real terminal text, so it collapses to ''.
 */
function terminalSnapshot(readTerminal) {
  if (typeof readTerminal !== 'function') return '';
  let raw = '';
  try {
    raw = readTerminal() || '';
  } catch {
    return '';
  }
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^\([^\n]*\)$/.test(trimmed)) return '';
  return truncateTerminalBuffer(raw);
}

export { smartTruncate, truncateTerminalBuffer, terminalSnapshot };
