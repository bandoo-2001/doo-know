import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applicationRoot } from './config.js';
export function releaseInfo(root = applicationRoot()) {
  const path = join(root, 'release.json');
  if (existsSync(path)) {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value.version !== 'string' || !Number.isInteger(value.databaseCompatibility))
      throw Error('发行元数据不完整');
    return value as {
      version: string;
      databaseCompatibility: number;
      source?: string;
      sourceCommit?: string;
      dirty?: boolean;
    };
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return { version: String(pkg.version) + '-dev', databaseCompatibility: 2 };
}
