/** Only resource-bearing HTML tags in parsed HTML tokens are scanned, never code text. */
export type HtmlResourceSpan = {
  start: number;
  end: number;
  url: string;
  html: true;
  media?: boolean;
};
export function htmlResourceSpans(
  html: string,
  decode: (value: string) => string = (s) => s,
): HtmlResourceSpan[] {
  const spans: HtmlResourceSpan[] = [];
  const tags =
    /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(html))) {
    if (!tag[1]) continue;
    const kind = tag[1].toLowerCase();
    if (['script', 'style', 'textarea', 'title'].includes(kind)) {
      const end = new RegExp('</' + kind + '\\s*>', 'gi');
      end.lastIndex = tags.lastIndex;
      const close = end.exec(html);
      tags.lastIndex = close ? end.lastIndex : html.length;
      continue;
    }
    if (!['img', 'video', 'audio', 'source', 'track'].includes(kind)) continue;
    const attrs = /([^\s=<>"'`/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>"'`=]+))/g;
    for (const attr of tag[0].matchAll(attrs)) {
      const name = attr[1].toLowerCase();
      if (!['src', 'srcset', 'poster'].includes(name)) continue;
      if (name === 'poster' && kind !== 'video') continue;
      if (name === 'srcset' && !['img', 'source'].includes(kind)) continue;
      const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      const valueStart =
        tag.index! +
        attr.index! +
        attr[0].length -
        value.length -
        (attr[2] !== undefined || attr[3] !== undefined ? 1 : 0);
      const add = (begin: number, end: number) => {
        if (end > begin)
          spans.push({
            start: valueStart + begin,
            end: valueStart + end,
            url: decode(value.slice(begin, end)),
            html: true,
            ...(name === 'src' && ['video', 'audio', 'source'].includes(kind)
              ? { media: true }
              : {}),
          });
      };
      if (name !== 'srcset') {
        add(0, value.length);
        continue;
      }
      // WHATWG candidate tokenization: commas inside a data URL belong to its URL.
      let at = 0;
      while (at < value.length) {
        while (at < value.length && /[\s,]/.test(value[at])) at++;
        const begin = at;
        while (at < value.length && !/\s/.test(value[at])) at++;
        let end = at;
        while (end > begin && value[end - 1] === ',') end--;
        add(begin, end);
        if (end < at) continue;
        let parens = 0;
        while (at < value.length) {
          const c = value[at++];
          if (c === '(') parens++;
          if (c === ')') parens--;
          if (c === ',' && parens <= 0) break;
        }
      }
    }
  }
  return spans;
}
