import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

export function pdfAssets(packageRoot: string): Plugin {
  const assets = new Map<string, string>();
  for (const directory of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
    const source = join(packageRoot, directory);
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isFile()) assets.set(directory + '/' + entry.name, join(source, entry.name));
    }
  }
  return {
    name: 'dooknow-pdf-assets',
    configureServer(server) {
      server.middlewares.use('/assets/pdfjs/', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].slice(1);
        const source = assets.get(name);
        if (!source) return next();
        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
        );
        createReadStream(source).on('error', next).pipe(res);
      });
    },
    generateBundle() {
      for (const [name, source] of assets) {
        this.emitFile({
          type: 'asset',
          fileName: 'assets/pdfjs/' + name,
          source: readFileSync(source),
        });
      }
    },
  };
}
