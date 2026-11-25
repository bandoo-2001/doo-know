import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { RemoteDependencies } from '../packages/core/portable-delivery/remote.js';
import { extractWebPage } from '../packages/core/web-capture/extract.js';
import { fetchWebPage, normalizeWebCaptureUrl } from '../packages/core/web-capture/index.js';

type FixtureResponse = {
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: string | Buffer;
};

function fixtureRequest(handler: (url: URL) => FixtureResponse | undefined): RemoteDependencies {
  const address = '93.184.216.34';
  return {
    resolve: async () => [{ address, family: 4 }],
    request: (url, options, callback) => {
      options.lookup?.(url.hostname, { all: true }, (error, addresses) => {
        expect(error).toBeNull();
        expect(addresses).toEqual([{ address, family: 4 }]);
      });
      expect(options.headers).not.toHaveProperty('Cookie');
      expect(options.headers).not.toHaveProperty('Authorization');
      const request = new EventEmitter();
      return Object.assign(request, {
        end() {
          const fixture = handler(url);
          if (!fixture) return;
          const body = Object.assign(new PassThrough(), {
            statusCode: fixture.status ?? 200,
            headers: { 'content-type': 'text/html; charset=utf-8', ...fixture.headers },
          });
          queueMicrotask(() => {
            callback(body as unknown as IncomingMessage);
            body.end(fixture.body);
          });
        },
        destroy(reason?: Error) {
          if (reason) request.emit('error', reason);
        },
      }) as unknown as ClientRequest;
    },
  };
}

describe('HTML to Markdown', () => {
  const finalUrl = new URL('https://example.org/docs/first');

  it('picks the article, keeps visible structure, and resolves only supported links', () => {
    const result = extractWebPage(
      `<html><head><title>Site suffix</title><base href="https://unrelated.test/"></head><body>
      <header role="banner">Site header</header><nav>Other pages</nav><main><article>
      <div hidden><h1>Hidden title</h1></div>
      <h1>使用 &amp; 恢复</h1><p>2026 年更新。<strong>读我</strong> &lt;not HTML&gt;</p>
      <h2>步骤</h2><ol><li>读取文档<ul><li>核对版本</li></ul></li><li>执行命令</li></ol>
      <pre><code class="language-bash">echo &#96;&#96;&#96;\n  done</code></pre>
      <blockquote><p>关键说明</p></blockquote>
      <p>!<a href="../guide?a=1&amp;b=2">指南</a>，<a href="javascript:alert(1)">危险链接</a>
      <a href="https://user:secret@other.test/">带凭据链接</a><img src="https://images.test/one.jpg" alt="示意图"/></p>
      <aside>Advertisement</aside><script>alert('inert')</script><form>Search controls</form>
      </article></main><footer>Legal footer</footer></body></html>`,
      finalUrl,
    );
    expect(result.title).toBe('使用 & 恢复');
    expect(result.markdown).toMatch(/^2026 年更新。\*\*读我\*\*/);
    expect(result.markdown).toContain('## 步骤');
    expect(result.markdown).toContain('1. 读取文档\n\n   - 核对版本\n2. 执行命令');
    expect(result.markdown).toContain('````bash\necho ```\n  done\n````');
    expect(result.markdown).toContain('> 关键说明');
    expect(result.markdown).toContain('\\![指南](<https://example.org/guide?a=1&b=2>)');
    expect(result.markdown).toContain('危险链接');
    expect(result.markdown).toContain('示意图');
    expect(result.markdown).not.toMatch(
      /unrelated|javascript:|user:secret|images\.test|inert|Advertisement|Other pages|Search controls|Legal footer|Hidden title/,
    );
  });

  it('uses a visible title and keeps literal Markdown, code, and size budgets', () => {
    const result = extractWebPage(
      `<title>Example title</title><body><nav><h1>Wrong title</h1></nav>
       <p>5. Keep the number<br>2026 stays plain</p>
       <p>[[Private note]] and &lt;img src="/tracking"&gt;</p>
       <pre><code class="language-mermaid">graph TD</code></pre></body>`,
      finalUrl,
    );
    expect(result).toEqual({
      title: 'Example title',
      markdown:
        '5\\. Keep the number  \n2026 stays plain\n\n\\[\\[Private note\\]\\] and \\<img src="/tracking"\\>\n\n```\ngraph TD\n```',
    });
    expect(() => extractWebPage('<nav>No article</nav>', finalUrl)).toThrowError(
      expect.objectContaining({ code: 'WEB_CAPTURE_EMPTY' }),
    );
    expect(() => extractWebPage(`<p>${'文'.repeat(90_000)}</p>`, finalUrl)).toThrowError(
      expect.objectContaining({ code: 'WEB_CAPTURE_TOO_LARGE' }),
    );
    expect(() => extractWebPage(`${'<div>'.repeat(100)}deep`, finalUrl)).toThrowError(
      expect.objectContaining({ code: 'WEB_CAPTURE_TOO_LARGE' }),
    );
  });
});

describe('public webpage fetch', () => {
  it('keeps the submitted normalized source while resolving links against the final URL', async () => {
    const calls: string[] = [];
    const result = await fetchWebPage(
      ' HTTPS://EXAMPLE.ORG/start#anchor ',
      fixtureRequest((url) => {
        calls.push(url.href);
        if (url.pathname === '/start')
          return { status: 302, headers: { location: 'https://example.net/docs/final' } };
        return { body: '<h1>Example</h1><p><a href="next">Next</a></p>' };
      }),
    );
    expect(result).toEqual({
      sourceUrl: 'https://example.org/start#anchor',
      title: 'Example',
      markdown: '[Next](<https://example.net/docs/next>)',
    });
    expect(calls).toEqual(['https://example.org/start', 'https://example.net/docs/final']);
  });

  it('blocks unsuitable URLs, redirect destinations, mixed DNS, and timeout', async () => {
    for (const url of [
      'file:///tmp/capture',
      'http://user:pass@example.org/',
      'http://example.org:8080/',
    ])
      expect(() => normalizeWebCaptureUrl(url)).toThrowError(
        expect.objectContaining({ code: 'WEB_CAPTURE_INVALID_URL' }),
      );
    expect(() => normalizeWebCaptureUrl('https://127.1/')).toThrowError(
      expect.objectContaining({ code: 'WEB_CAPTURE_BLOCKED' }),
    );
    const deps = fixtureRequest(() => ({
      status: 302,
      headers: { location: 'https://127.0.0.1/' },
    }));
    await expect(fetchWebPage('https://example.org', deps)).rejects.toMatchObject({
      code: 'WEB_CAPTURE_BLOCKED',
    });
    await expect(
      fetchWebPage('https://example.org', {
        ...deps,
        resolve: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.2', family: 4 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'WEB_CAPTURE_BLOCKED' });
    await expect(
      fetchWebPage('https://example.org', {
        ...fixtureRequest(() => undefined),
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: 'WEB_CAPTURE_TIMEOUT' });
  });

  it('limits streaming and decompressed bytes and rejects other media', async () => {
    const url = 'https://example.org';
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 65);
    for (const fixture of [
      { headers: { 'content-length': String(oversized.length) } },
      { body: oversized },
      { body: gzipSync(oversized), headers: { 'content-encoding': 'gzip' } },
    ])
      await expect(
        fetchWebPage(
          url,
          fixtureRequest(() => fixture),
        ),
      ).rejects.toMatchObject({
        code: 'WEB_CAPTURE_TOO_LARGE',
      });
    await expect(
      fetchWebPage(
        url,
        fixtureRequest(() => ({
          headers: { 'content-type': 'application/pdf' },
          body: '%PDF-1.0',
        })),
      ),
    ).rejects.toMatchObject({ code: 'WEB_CAPTURE_UNSUPPORTED' });
  });
});
