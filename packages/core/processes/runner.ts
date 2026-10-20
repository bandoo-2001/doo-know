import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fail } from '../knowledge/errors.js';

let verified: string | undefined;
export function processRunner() {
  const file = fileURLToPath(new URL('./.build/process-runner', import.meta.url));
  try {
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o022 ||
      !(info.mode & 0o100)
    )
      throw Error();
    const identity = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
    if (verified !== identity) {
      // Check in a separate process; no policy is installed in the application.
      // No workload has been authorized, so this failure is never an uncertain push.
      execFileSync(file, ['--check'], {
        cwd: '/',
        timeout: 3000,
        stdio: 'ignore',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' },
      });
      verified = identity;
    }
    return file;
  } catch {
    fail(
      503,
      'PROCESS_CONTAINMENT_UNAVAILABLE',
      '后台任务暂时无法启动，请联系部署者检查安装和系统支持。',
    );
  }
}
