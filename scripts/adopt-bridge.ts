import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { parse as parseEnv } from 'dotenv';
import { openSync, readFileSync, fstatSync, closeSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { loadHostConfig } from '../apps/server/platform/config.js';
import { openDatabase } from '../packages/core/db.js';
import { adoptLegacyTunnel } from '../apps/server/platform/bridge-adoption.js';
const { values } = parseArgs({
  options: {
    profile: { type: 'string' },
    'bridge-config': { type: 'string' },
    'backend-policy-file': { type: 'string' },
    'tunnel-env-file': { type: 'string' },
    'token-env-name': { type: 'string' },
    'compat-port': { type: 'string' },
    'tunnel-origin': { type: 'string' },
  },
});
function controlled(file: string, max = 65536) {
  const fd = openSync(
    resolve(file),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.size > max ||
      ![0o400, 0o440, 0o600, 0o640].includes(st.mode & 0o777) ||
      st.uid !== process.getuid!()
    )
      throw Error('旧配置不是受控普通文件');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
async function main() {
  for (const flag of [
    'profile',
    'bridge-config',
    'backend-policy-file',
    'tunnel-env-file',
    'token-env-name',
  ] as const)
    if (!values[flag]) throw Error('缺少 --' + flag + '；凭据仅从受控文件读取');
  const bridge = parseYaml(controlled(values['bridge-config']!)),
    backend = JSON.parse(controlled(values['backend-policy-file']!)),
    tunnel = parseEnv(controlled(values['tunnel-env-file']!));
  const supplied = tunnel[values['token-env-name']!];
  const bearer =
    typeof supplied === 'string' && supplied.startsWith('Bearer ') ? supplied.slice(7) : supplied;
  if (typeof bearer !== 'string') throw Error('指定的凭据字段不存在');
  if (typeof bridge.tokenFile !== 'string' || !bridge.tokenFile.startsWith('/'))
    throw Error('旧 Token 清单必须为显式绝对路径');
  const tokens = JSON.parse(controlled(bridge.tokenFile)),
    config = loadHostConfig({ profileFile: resolve(values.profile!) }),
    db = openDatabase(config.dataRoot);
  try {
    const result = await adoptLegacyTunnel(db, config, {
      bearer,
      tokens,
      bridgePolicies: bridge.policies,
      backendPolicies: backend.policies,
      compatPort: Number(values['compat-port'] || 3071),
      tunnelOrigin: values['tunnel-origin'],
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}
main().catch(() => {
  console.error(
    '旧 Bridge 承接未完成。请核对服务停写状态、受控文件、原始凭据有效性及身份，未输出任何凭据。',
  );
  process.exitCode = 1;
});
