import { expect, it } from 'vitest';
import { validateSvgSource } from '../packages/core/svg.js';

const xml = (body: string, attributes = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
const check = (source: string) => validateSvgSource(new TextEncoder().encode(source));

it('canonicalizes namespaced SVG, local gradient references and escaped text without changing source', () => {
  const source =
    '<s:svg xmlns:s="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 120 40">' +
    '<s:defs><s:linearGradient id="base"><s:stop offset="0" stop-color="red"/></s:linearGradient>' +
    '<s:linearGradient id="derived" xlink:href="#base"/>' +
    '<s:clipPath id="cut"><s:rect width="100" height="30"/></s:clipPath></s:defs>' +
    '<s:path d="M0 0h120v40z" fill="url(&quot;#derived&quot;)" clip-path="url(#cut)"/>' +
    '<s:text x="5" y="20"><![CDATA[<测试>]]>&#32;&amp;</s:text></s:svg>';
  const result = check(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.source).toBe(source);
  expect(result).toMatchObject({ width: 120, height: 40 });
  expect(result.presentation).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
  expect(result.presentation).toContain('href="#base"');
  expect(result.presentation).toContain('&lt;测试&gt; &amp;');
  expect(result.presentation).not.toContain('s:');
  expect(check(result.presentation)).toMatchObject({ ok: true, width: 120, height: 40 });
});

it.each([
  [
    'direct clip recursion',
    xml(
      '<defs><clipPath id="a" clip-path="url(#a)"><rect width="10" height="10"/></clipPath></defs><path d="M0 0" clip-path="url(#a)"/>',
    ),
  ],
  [
    'indirect clip recursion',
    xml(
      '<defs><clipPath id="a"><g clip-path="url(#b)"><rect width="10" height="10"/></g></clipPath><clipPath id="b"><path d="M0 0" clip-path="url(#a)"/></clipPath></defs>',
    ),
  ],
  [
    'source requiring an oversized serialized presentation',
    xml('<text>' + '>'.repeat(300000) + '</text>'),
  ],
])('rejects %s before returning a presentation', (_name, source) => {
  expect(check(source).ok).toBe(false);
});

it('rejects an acyclic clip graph whose repeated references expand beyond the rendering budget', () => {
  const clips =
    '<clipPath id="c0"><rect width="10" height="10"/></clipPath>' +
    Array.from(
      { length: 14 },
      (_, index) =>
        `<clipPath id="c${index + 1}"><rect width="10" height="10" clip-path="url(#c${index})"/><rect width="10" height="10" clip-path="url(#c${index})"/></clipPath>`,
    ).join('');
  expect(
    check(xml(`<defs>${clips}</defs><rect width="10" height="10" clip-path="url(#c14)"/>`)).ok,
  ).toBe(false);
});

it.each([
  ['missing namespace', '<svg/>'],
  ['unknown element', xml('<unknown/>')],
  ['external namespace attribute', xml('<path xmlns:q="http://evil.invalid/" q:href="x"/>')],
  ['missing local resource', xml('<path d="M0 0" fill="url(#missing)"/>')],
  [
    'a local reference targeting the wrong element type',
    xml('<path id="not-a-gradient" d="M0 0"/><path d="M0 0" fill="url(#not-a-gradient)"/>'),
  ],
  [
    'ambiguous href namespaces',
    xml(
      '<defs><linearGradient id="a"/><linearGradient xmlns:xlink="http://www.w3.org/1999/xlink" href="#a" xlink:href="#a"/></defs>',
    ),
  ],
  ['attribute containing control characters', xml('<text aria-label="\u0001">text</text>')],
  ['CSS escapes', xml('<path d="M0 0" fill="u\\72l(https://evil.invalid/)"/>')],
  ['multiple roots', xml('') + xml('')],
  ['unexpected source text', xml('not a text node')],
  ['non-finite geometry', xml('<path d="M0 1e9999"/>')],
])('rejects %s with a structured reason', (_name, source) => {
  expect(check(source)).toEqual({
    ok: false,
    code: expect.any(String),
    message: expect.any(String),
  });
});
