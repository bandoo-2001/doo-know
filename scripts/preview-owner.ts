import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../apps/server/config.js';
import { initializeOwner } from '../apps/server/auth.js';
import { openDatabase } from '../packages/core/db.js';
if (process.env.KNOWLEDGE_ROOT || process.env.NODE_ENV === 'production')
  throw new Error('仅允许隔离示例库');
const config = loadConfig();
const db = openDatabase(config.dataRoot);
const exists =
  db.prepare("SELECT name FROM sqlite_master WHERE name='user'").get() &&
  db.prepare('SELECT 1 FROM user LIMIT 1').get();
db.close();
if (!exists) {
  const password = randomBytes(24).toString('base64url');
  await initializeOwner(config, 'owner', password);
  const secrets = join(
    process.env.DOOKNOW_DEMO_ROOT || join(homedir(), '.local/share/doo-know-web-demo'),
    'secrets',
  );
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(secrets, 'demo-login.txt'),
    `用户名：owner\n密码：${password}\n仅用于本机隔离示例库，请使用 npm run account -- reset 自行设置密码。\n`,
    { mode: 0o600, flag: 'wx' },
  );
  console.log('示例账号已创建，登录信息仅保存在本机受控密钥目录。');
} else console.log('已存在账号，未修改凭据。');
