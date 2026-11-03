import { expect, it } from 'vitest';
import { destinations, rewriteDestinations } from '../packages/core/portable-delivery/paths';
it('finds and rewrites real HTML resources while preserving code and adds media fallback links', () => {
  const src =
    '`<img src="code.png">`\n\n```html\n<video src="code.mp4"></video>\n```\n\n<img src="图.png" srcset="small.png 1x, large.png 2x">\n<video poster="poster.png"><source src="clip.mp4" type="video/mp4"></video>\n<audio src="sound.mp3"></audio>\n';
  const urls = destinations(src).map((x) => x.url);
  expect(urls).toEqual(['图.png', 'small.png', 'large.png', 'poster.png', 'clip.mp4', 'sound.mp3']);
  const map = new Map(urls.map((p, i) => ['a/' + p, '_doo-assets/' + i + p.slice(p.lastIndexOf('.'))]));
  const out = rewriteDestinations(src, 'a/n.md', 'a/n.md', map);
  expect(out).toContain('src="../_doo-assets/4.mp4"');
  expect(out).toContain('[媒体文件](<../_doo-assets/4.mp4>)');
  expect(out).toContain('srcset="../_doo-assets/1.png 1x, ../_doo-assets/2.png 2x"');
  expect(out).toContain('src="code.png"');
  expect(out).toContain('src="code.mp4"');
});
it('rewrites typed data URLs and remote media by exact destination spans', () => {
  const url = 'data:audio/wav;base64,UklGRg==',
    remote = 'https://example.test/a.mp4?a=1&b=2';
  const s = `<audio src="${url}"></audio>\n<video src="${remote.replace('&', '&amp;')}"></video>`;
  const out = rewriteDestinations(
    s,
    'n.md',
    'n.md',
    new Map([
      [url, '_doo-assets/a.wav'],
      [remote, '_doo-assets/a.mp4'],
    ]),
  );
  expect(out).toContain('src="_doo-assets/a.wav"');
  expect(out).toContain('src="_doo-assets/a.mp4"');
});

it('keeps HTML comments and raw-text code opaque to media discovery', () => {
  const src =
    'hello <script>const fake="<img src=inline.png>";</script>\n\n<!-- <img src="example.png"> -->\n<script>const example="<img src=example.png>";</script>\n<textarea><img src="example.png"></textarea>\n<img src="real.png">';
  expect(destinations(src).map((x) => x.url)).toEqual(['real.png']);
});
