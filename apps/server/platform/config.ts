import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import { privateFile } from '../../../packages/core/agent/config.js';
import { boundProfile, resolveProfileFile } from './profile.js';

export function applicationRoot() {
  let path = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(path, 'package.json'))) {
    const parent = dirname(path);
    if (parent === path) throw new Error('找不到 DooKnow 发行目录');
    path = parent;
  }
  return path;
}
export function loadHostConfig(overrides: Partial<HostConfig> = {}, env: NodeJS.ProcessEnv = process.env): HostConfig {
  const home = homedir(), configRoot = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'doo-know');
  const profileFile = resolveProfileFile(overrides.profileFile, env, { installRoot: overrides.installRoot });
  let profile: Record<string, any>;
  try { profile = JSON.parse(readFileSync(profileFile, 'utf8')); }
  catch (error) {
    // Explicit and installed selections must also fail closed if the file is
    // removed between profile resolution and this read.
    const required = overrides.profileFile || env.DOOKNOW_PROFILE || overrides.installRoot || env.DOOKNOW_INSTALL_ROOT;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || required) throw error;
    profile = {};
  }
  const fromEnv = Object.fromEntries(Object.entries({
    knowledgeRoot: env.KNOWLEDGE_ROOT, dataRoot: env.DATA_ROOT, secretFile: env.AUTH_SECRET_FILE,
    origin: env.APP_ORIGIN, port: env.PORT && Number(env.PORT), host: env.HOST,
    vectorRuntimeRoot: env.VECTOR_RUNTIME_ROOT, modelDir: env.MODEL_DIR, tokenizerPython: env.TOKENIZER_PYTHON,
    vectorServiceUrl: env.VECTOR_SERVICE_URL, embeddingSpaceId: env.EMBEDDING_SPACE_ID,
    agentConfigFile: env.AGENT_CONFIG_FILE, installRoot:env.DOOKNOW_INSTALL_ROOT,
  }).filter(([, v]) => v !== undefined && v !== ''));
  const options = { ...profile, ...fromEnv, ...overrides };
  if (profile.installRoot && options.installRoot &&
      resolve(profile.installRoot) !== resolve(options.installRoot))
    throw new Error('此配置已属于另一安装目录；独立安装请使用新的 --profile');
  if (options.installRoot) {
    const owner = boundProfile(options.installRoot);
    if (owner && owner !== profileFile)
      throw new Error('此安装目录已绑定另一配置；独立安装请使用新的安装目录');
  }
  const port = Number(options.port || 5173), origin = options.origin || `http://127.0.0.1:${port}`;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在1–65535之间');
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('访问地址必须为完整来源，不含路径');
  const secretFile = resolve(options.secretFile || join(configRoot, 'secrets', 'auth.key'));
  const info = lstatSync(secretFile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077)) throw new Error('认证密钥必须为私有普通文件，权限600');
  const secret = readFileSync(secretFile, 'utf8').trim();
  if (secret.length < 32) throw new Error('认证密钥长度不足');
  const root = options.applicationRoot || applicationRoot();
  const vectorServiceTokenFile = env.VECTOR_SERVICE_TOKEN_FILE || options.vectorServiceTokenFile;
  return {
    ...options, profileFile, secretFile, secret, applicationRoot: root,
    dataRoot: resolve(options.dataRoot || join(env.XDG_DATA_HOME || join(home, '.local/share'), 'doo-know/data')),
    ...(options.knowledgeRoot ? { knowledgeRoot: resolve(options.knowledgeRoot) } : {}),
    origin, port, host: options.host || '127.0.0.1', staticRoot: options.staticRoot || join(root, 'dist/web'),
    allowedKnowledgeBases: options.allowedKnowledgeBases || [home],
    vectorRuntimeRoot: options.vectorRuntimeRoot || join(root, 'runtime/vector-service'),
    ...(vectorServiceTokenFile ? { vectorServiceToken: privateFile(vectorServiceTokenFile, 8192).trim() } : {}),
    indexing: options.indexing || { enabled: env.INDEXING_ENABLED !== '0', watch: env.INDEX_WATCH !== '0', embedded: env.EMBEDDED_INDEX_WORKER !== '0' },
    fileTasks: options.fileTasks || { embedded: env.EMBEDDED_FILE_WORKER !== '0' },
    gitSyncEnabled: options.gitSyncEnabled ?? env.GIT_SYNC_ENABLED === '1',
  };
}
