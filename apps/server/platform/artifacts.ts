import { createServer } from 'node:http';
import { lstatSync, realpathSync, open, constants, createReadStream, close } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
const allowed =
  /^(?:install\.sh|release(?:-[0-9A-Za-z.+-]{1,80})?\.(?:txt|json)|catalog\.json|dooknow-[0-9A-Za-z.+-]{1,120}\.tar\.gz)$/;
export function createArtifactServer(directory: string) {
  const root = resolve(directory),
    info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(root) !== root)
    throw Error('制品目录须为真实绝对目录');
  return createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method || '')) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let filename: string;
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      filename = url.pathname.slice(1);
      if (!allowed.test(filename) || url.search || url.hash) throw Error();
      const host = new URL('http://' + request.headers.host).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw Error();
    } catch {
      response.writeHead(404).end();
      return;
    }
    open(
      join(root, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      (error, fd) => {
        if (error) {
          response.writeHead(404).end();
          return;
        }
        import('node:fs')
          .then(({ fstat }) =>
            fstat(fd, (failure, st) => {
              if (failure || !st.isFile() || st.nlink !== 1) {
                close(fd, () => {});
                response.writeHead(404).end();
                return;
              }
              response.setHeader(
                'Content-Type',
                filename.endsWith('.json')
                  ? 'application/json'
                  : filename.endsWith('.sh')
                    ? 'text/x-shellscript'
                    : 'application/octet-stream',
              );
              response.setHeader('Content-Length', st.size);
              if (request.method === 'HEAD') {
                close(fd, () => {});
                response.end();
                return;
              }
              void pipeline(createReadStream('', { fd, autoClose: true }), response).catch(() => {
                if (!response.writableEnded) response.destroy();
              });
            }),
          )
          .catch(() => {
            close(fd, () => {});
            response.writeHead(500).end();
          });
      },
    );
  });
}
