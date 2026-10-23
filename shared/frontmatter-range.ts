/** Shared delimiter rules; parsing YAML values is the property editor's job. */
export const frontmatterOpening = /^\uFEFF?---[ \t]*(\r?\n)/;

export function frontmatterRange(markdown: string) {
  const opening = frontmatterOpening.exec(markdown);
  if (!opening) return undefined;
  const closingPattern = /^(?:---|\.\.\.)[ \t]*\r?(?:\n|$)/gm;
  closingPattern.lastIndex = opening[0].length;
  const closing = closingPattern.exec(markdown);
  if (!closing) return undefined;
  return {
    from: opening[0].length,
    to: closing.index,
    end: closing.index + closing[0].length,
    yaml: markdown.slice(opening[0].length, closing.index),
  };
}
