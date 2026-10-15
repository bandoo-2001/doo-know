import { parseArgs } from 'node:util';
import { createArtifactServer } from '../apps/server/platform/artifacts.js';
const { values } = parseArgs({
  options: { directory: { type: 'string' }, port: { type: 'string' } },
});
if (!values.directory) throw Error('需要 --directory <私有制品目录>');
const port = Number(values.port || 3181);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('端口必须在1024–65535之间');
const server = createArtifactServer(values.directory);
server.once('error', () => {
  console.error('私有制品源启动失败，请检查目录和端口');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log('私有制品源：http://127.0.0.1:' + port));
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => server.close(() => process.exit(0)));
