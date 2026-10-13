import { backup } from '../server/backup.js';
import { loadConfig } from '../server/config.js';
if (!process.argv[2])
  throw new Error('用法：npm run backup -- <尚不存在的备份目录>；先停止应用与外部编辑');
await backup(loadConfig(), process.argv[2]);
console.log('原文、SQLite 一致性副本、历史备份及校验清单已完成。密钥需单独受控加密备份。');
