import 'dotenv/config';
import { readFileSync, mkdirSync, existsSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../shared/contracts.js';
import { loadAgentConfig, privateFile } from '../../packages/core/agent/config.js';
export function loadConfig(): AppConfig {
  const base = process.env.DOOKNOW_DEMO_ROOT || join(homedir(), '.local/share/doo-know-web-demo');
  const production = process.env.NODE_ENV === 'production';
  if (
    production &&
    (!process.env.KNOWLEDGE_ROOT ||
      !process.env.DATA_ROOT ||
      !process.env.AUTH_SECRET_FILE ||
      !process.env.APP_ORIGIN)
  )
    throw new Error('生产运行需要明确配置原文、数据、密钥和访问来源');
  const knowledgeRoot = resolve(process.env.KNOWLEDGE_ROOT || join(base, 'knowledge')),
    dataRoot = resolve(process.env.DATA_ROOT || join(base, 'data')),
    secretFile = resolve(process.env.AUTH_SECRET_FILE || join(base, 'secrets/auth.key'));
  if (!existsSync(secretFile) && !production) {
    mkdirSync(resolve(secretFile, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(secretFile, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 });
  }
  if (lstatSync(secretFile).mode & 0o077) throw new Error('认证密钥文件权限需为 600');
  const secret = readFileSync(secretFile, 'utf8').trim();
  if (secret.length < 32) throw new Error('认证密钥长度不足');
  if (
    knowledgeRoot === dataRoot ||
    dataRoot.startsWith(knowledgeRoot + '/') ||
    knowledgeRoot.startsWith(dataRoot + '/')
  )
    throw new Error('原文与运行数据目录必须独立');
  const port = Number(process.env.PORT || 3010),
    origin = process.env.APP_ORIGIN || 'http://127.0.0.1:5173';
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
    throw new Error('APP_ORIGIN 必须为完整来源，不含路径');
  return {
    knowledgeRoot,
    dataRoot,
    secret,
    origin,
    port,
    host: process.env.HOST || '127.0.0.1',
    staticRoot: resolve('dist/web'),
    ...(process.env.VECTOR_RUNTIME_ROOT
      ? { vectorRuntimeRoot: resolve(process.env.VECTOR_RUNTIME_ROOT) }
      : {}),
    ...(process.env.MODEL_DIR ? { modelDir: resolve(process.env.MODEL_DIR) } : {}),
    ...(process.env.TOKENIZER_PYTHON
      ? { tokenizerPython: resolve(process.env.TOKENIZER_PYTHON) }
      : {}),
    ...(process.env.AGENT_CONFIG_FILE
      ? {
          agentConfigFile: resolve(process.env.AGENT_CONFIG_FILE),
          agent: loadAgentConfig(resolve(process.env.AGENT_CONFIG_FILE), knowledgeRoot),
        }
      : {}),
    ...(process.env.VECTOR_SERVICE_URL ? { vectorServiceUrl: process.env.VECTOR_SERVICE_URL } : {}),
    ...(process.env.VECTOR_SERVICE_TOKEN_FILE
      ? { vectorServiceToken: privateFile(process.env.VECTOR_SERVICE_TOKEN_FILE, 8192).trim() }
      : {}),
    ...(process.env.EMBEDDING_SPACE_ID ? { embeddingSpaceId: process.env.EMBEDDING_SPACE_ID } : {}),
    fileTasks: { embedded: process.env.EMBEDDED_FILE_WORKER !== '0' },
    gitSyncEnabled: process.env.GIT_SYNC_ENABLED === '1',
    indexing: {
      enabled: process.env.INDEXING_ENABLED !== '0',
      watch: process.env.INDEX_WATCH !== '0',
      embedded: process.env.EMBEDDED_INDEX_WORKER !== '0',
    },
  };
}
