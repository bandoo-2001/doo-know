import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

/** Developer-side upload: stream with curl so the host's proxy environment applies. */
export async function curlGithubUpload(url: string, headers: Record<string, string>, file: string, bytes: number) {
  const target = new URL(url);
  if (target.origin !== 'https://uploads.github.com' || target.username || target.password || target.hash || !/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/releases\/[1-9][0-9]*\/assets$/.test(target.pathname)) throw Error('INVALID_GITHUB_UPLOAD_TARGET');
  const work = await mkdtemp(join(dirname(file), '.curl-upload-'));
  try {
    const values = { ...headers, 'content-length': String(bytes) };
    const lines = Object.entries(values).map(([name, value]) => {
      if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n\0]/.test(value) || value.length > 8192) throw Error('INVALID_GITHUB_UPLOAD_HEADER');
      return 'header = "' + (name + ': ' + value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    });
    const config = join(work, 'curl'), body = join(work, 'response');
    await writeFile(config, lines.join('\n') + '\n', { mode: 0o600 });
    let status = '';
    const code = await new Promise<number>((yes, no) => {
      const child = spawn('curl', ['-q', '--config', config, '--proto', '=https', '--max-redirs', '0', '--request', 'POST', '--upload-file', file, '--silent', '--connect-timeout', '20', '--max-time', '1800', '--output', body, '--write-out', '%{http_code}', url], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', b => { status += b.toString(); if (status.length > 32) child.kill(); });
      child.on('error', () => no(Error('GITHUB_UPLOAD_CURL_UNAVAILABLE')));
      child.on('exit', value => yes(value ?? -1));
    });
    if (code !== 0 || !/^[1-5][0-9]{2}$/.test(status)) throw Error('GITHUB_UPLOAD_NETWORK_FAILED');
    if (Number(status) < 200 || Number(status) > 299) throw Error('GITHUB_UPLOAD_HTTP_' + status);
    if ((await stat(body)).size > 1024 * 1024) throw Error('GITHUB_UPLOAD_RESPONSE_TOO_LARGE');
    return new Response(await readFile(body), { status: Number(status), headers: { 'content-type': 'application/json' } });
  } finally { await rm(work, { recursive: true, force: true }); }
}
