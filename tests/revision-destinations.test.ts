import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanRevisionDestinations } from '../packages/core/knowledge/revision-relocation';
it.each(['\n', '\r\n', '\r'])(
  'keeps metadata, quoted fences and raw HTML/comment examples opaque during bounded history scanning (%j)',
  (newline) => {
    const root = mkdtempSync(join(tmpdir(), 'revision-syntax-'));
    try {
      const prefix = [
          '---',
          'metadata: "[ignored](target.md#metadata)"',
          '---',
          '',
          '> ```md',
          '>',
          '> [example](target.md#code)',
          '> ```',
          '',
          '<script>',
          '',
          '[example](target.md#script)',
          '</script>',
          '',
          '<!-- Example',
          '',
          '[example](target.md#comment)',
          '-->',
          '',
          '[real](target.md#real)',
          '',
          '',
        ].join(newline),
        source = prefix + 'x'.repeat(2 * 1024 * 1024),
        file = join(root, 'history.md');
      writeFileSync(file, source);
      const result = scanRevisionDestinations(file);
      expect(result.complete).toBe(true);
      expect(result.spans.map((span) => span.url)).toEqual(['target.md#real']);
      for (const span of result.spans)
        expect(Buffer.from(source).subarray(span.startByte, span.endByte).toString()).toBe(
          'target.md#real',
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
