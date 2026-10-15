import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';
import { loadConfig } from '../apps/server/config.js';
import { initializeOwner, resetOwnerPassword } from '../apps/server/auth.js';
if (!stdin.isTTY) throw new Error('账号管理必须在本机交互终端执行');
const mode = process.argv[2] || 'init';
if (!['init', 'reset'].includes(mode)) throw new Error('用法：npm run account -- init|reset');
let muted = false;
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) stdout.write(chunk);
    callback();
  },
});
const rl = createInterface({ input: stdin, output, terminal: true });
async function password(prompt: string) {
  stdout.write(prompt);
  muted = true;
  try {
    return await rl.question('');
  } finally {
    muted = false;
    stdout.write('\n');
  }
}
try {
  const name =
    mode === 'init' ? await rl.question('用户名（3–30 个字母、数字、点或下划线）：') : '';
  const p = await password('密码（至少 12 位，输入不显示）：'),
    confirm = await password('再次输入密码：');
  if (p !== confirm) throw new Error('两次密码不同');
  if (mode === 'init') await initializeOwner(loadConfig(), name, p);
  else await resetOwnerPassword(loadConfig(), p);
  console.log(mode === 'init' ? '唯一账号已创建。' : '密码已重置，旧会话已全部撤销。');
} finally {
  rl.close();
}
