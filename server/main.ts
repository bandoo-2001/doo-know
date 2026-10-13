import { createApp } from './app.js';
import { loadConfig } from './config.js';
const config = loadConfig();
const app = await createApp(config);
await app.listen({ host: config.host, port: config.port });
console.log(`DooKnow Web: ${config.origin}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
