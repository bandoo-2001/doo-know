#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const built = fileURLToPath(new URL('../dist/server/scripts/manage.js', import.meta.url));
const source = fileURLToPath(new URL('../scripts/manage.ts', import.meta.url));
const child = spawn(process.execPath, [...(existsSync(built) ? [built] : ['--import', 'tsx', source]), ...process.argv.slice(2)], { stdio: 'inherit' });
child.once('exit', code => { process.exitCode = code ?? 1; });
child.once('error', () => { console.error('无法启动 DooKnow'); process.exitCode = 1; });
