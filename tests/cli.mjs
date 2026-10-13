import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
for (const [file, message] of [
  ['account', '账号管理必须在本机交互终端执行'],
  ['backup', '用法：npm run backup'],
  ['restore', '用法：npm run restore'],
]) {
  const r = spawnSync(process.execPath, [`dist/server/scripts/${file}.js`], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 1);
  assert(r.stderr.includes(message), `${file}: compiled management entry unavailable`);
}
console.log('编译后的账号/备份/恢复命令入口可运行，无 TTY 时拒绝账号管理。');
