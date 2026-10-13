import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
const libs = resolve('.local/browser-deps/root/usr/lib/x86_64-linux-gnu');
const env = { ...process.env };
if (existsSync(libs))
  env.LD_LIBRARY_PATH = libs + (env.LD_LIBRARY_PATH ? delimiter + env.LD_LIBRARY_PATH : '');
const test = spawn(
  process.execPath,
  ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)],
  { stdio: 'inherit', env },
);
test.on('exit', (code) => process.exit(code ?? 1));
