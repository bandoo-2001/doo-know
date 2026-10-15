import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../apps/server/config.js';
import { categories } from '../packages/core/files.js';
const c = loadConfig();
if (process.env.KNOWLEDGE_ROOT || process.env.NODE_ENV === 'production')
  throw new Error('示例初始化只使用默认独立示例库，拒绝写入自定义原文目录');
for (const cat of categories)
  await mkdir(join(c.knowledgeRoot, cat), { recursive: true, mode: 0o700 });
await mkdir(join(c.knowledgeRoot, '30-Knowledge/个人知识管理/方法'), { recursive: true });
const files: Record<string, string> = {
  '30-Knowledge/个人知识管理/方法/搭建自己的知识库.md':
    '# 搭建自己的知识库\n\n把想法记录下来，让知识慢慢积累。\n\n## 整理方法\n\n- 收集值得保留的想法\n- 按主题整理笔记\n- 定期回顾与更新\n\n> 让知识慢慢积累。\n\n| 步骤 | 内容 |\n| --- | --- |\n| 收集 | 记录想法 |\n| 整理 | 建立主题 |\n\n## 每周回顾\n\n每周花一些时间回顾笔记，补充遗漏的内容。\n',
  '30-Knowledge/个人知识管理/方法/每周回顾.md':
    '# 每周回顾\n\n本周学到了什么？\n\n- 新的认识\n- 值得继续探索的问题\n',
  '00-Inbox/欢迎使用.md':
    '# 欢迎使用 DooKnow\n\n这是隔离的示例知识库。\n\n左侧选择文件夹或笔记，右侧可以编辑、预览或分屏。使用保存按钮或 Ctrl/Cmd+S 保存。\n\n默认私有，需要时可分享单篇笔记。',
};
for (const [path, body] of Object.entries(files))
  try {
    await writeFile(join(c.knowledgeRoot, path), body, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
console.log(
  '隔离示例库已就绪，已存在的示例文件未覆盖。运行 npm run account -- init 设置个人账号。',
);
