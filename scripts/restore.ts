import { restore } from '../server/backup.js';
import { loadConfig } from '../server/config.js';
if (!process.argv[2])
  throw new Error('用法：npm run restore -- <备份目录>；配置目标原文和数据目录，必须为空');
await restore(process.argv[2], loadConfig());
console.log('恢复及校验已完成，旧会话与旧分享均已停用。');
