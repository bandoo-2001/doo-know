import { createServer } from 'node:http';

/** Synthetic protocol fixture only; no external service or user document is involved. */
export async function graphModelFixture() {
  const server = createServer(async (request, response) => {
    if (
      request.method !== 'POST' ||
      !['/api/chat', '/chat/completions', '/v1/chat/completions'].includes(request.url || '')
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 131072) {
        response.writeHead(413);
        response.end();
        return;
      }
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const text = String(body.messages?.at(-1)?.content || '');
      let question: { question: string; context: { id: string; text: string }[] } | undefined;
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.context)) question = parsed;
      } catch {
        /* Extraction receives raw synthetic text. */
      }
      let result: unknown;
      if (question) {
        if (question.question.includes('慢速验证'))
          await new Promise((resolve) => setTimeout(resolve, 16000));
        const source =
          question.context.find(
            (item) => item.text.includes('Docker') && item.text.includes('Linux'),
          ) || question.context[0];
        result = {
          answer: source?.text.includes('依赖')
            ? 'Docker 依赖 Linux 内核。'
            : '当前原文说明了 Docker 与 Linux 的联系。',
          citations: source ? [source.id] : [],
        };
      } else {
        const quote = 'Docker 依赖 Linux 内核。';
        result = text.includes(quote)
          ? {
              entities: [
                { name: 'Docker', kind: 'technology', description: '容器技术', aliases: [], quote },
                {
                  name: 'Linux',
                  kind: 'technology',
                  description: '操作系统内核',
                  aliases: [],
                  quote,
                },
              ],
              relations: [
                {
                  source: 'Docker',
                  target: 'Linux',
                  predicate: '依赖',
                  description: 'Docker 使用 Linux 内核能力',
                  quote,
                  confidence: 0.94,
                },
              ],
            }
          : { entities: [], relations: [] };
      }
      const content = JSON.stringify(result);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          request.url?.includes('chat/completions')
            ? { choices: [{ message: { content } }] }
            : { message: { content } },
        ),
      );
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Synthetic graph fixture did not start');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
