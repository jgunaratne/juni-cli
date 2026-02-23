function smartTruncate(text, maxChars = 2000, headLines = 30, tailLines = 30) {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  if (lines.length <= headLines + tailLines) return text;
  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  const omitted = lines.length - headLines - tailLines;
  return [...head, `\n--- (${omitted} lines omitted) ---\n`, ...tail].join('\n');
}

export { smartTruncate };
