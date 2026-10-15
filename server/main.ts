import { createApp } from './app.js';
import { loadHostConfig } from './platform/config.js';
const config = loadHostConfig();
const app = await createApp(config);
await app.listen({ host: config.host, port: config.port });
console.log(`DooKnow: ${config.origin}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
