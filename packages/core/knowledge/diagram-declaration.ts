import { openSync, closeSync, readSync, fstatSync, constants } from 'node:fs';
import { limits } from './limits.js';
import { fail } from './errors.js';
import { readBlocks } from './file-reader.js';

const declaration = '<!-- dooknow:document';
/** Candidate scan only. The shared Markdown parser still decides the actual type.
 * Retain a short prefix and delimiter flags, never an unbounded frontmatter/ordinary line. */
function declarationScanner() {
  let mode: 'first' | 'frontmatter' | 'body' = 'first',
    prefix = '',
    leading = 0,
    nonblank = false;
  let opening = false,
    openingCount = 0,
    delimiter = '',
    cleanTail = true,
    lineLength = 0,
    pendingCR = false;
  const decoder = new TextDecoder('utf-8');
  const reset = () => {
    prefix = '';
    leading = 0;
    nonblank = false;
    opening = false;
    openingCount = 0;
    delimiter = '';
    cleanTail = true;
    lineLength = 0;
  };
  const endLine = (lf: boolean): boolean | undefined => {
    if (mode === 'frontmatter') {
      if ((delimiter === '---' || delimiter === '...') && cleanTail) mode = 'body';
      reset();
      return;
    }
    if (mode === 'first' && opening) {
      if (openingCount === 3 && lf) {
        mode = 'frontmatter';
        reset();
        return;
      }
      return false;
    }
    if (nonblank) return prefix === declaration;
    mode = 'body';
    reset();
  };
  const consume = (char: string): boolean | undefined => {
    if (pendingCR) {
      pendingCR = false;
      const result = endLine(char === '\n');
      if (result !== undefined) return result;
      if (char === '\n') return;
    }
    if (char === '\r') {
      pendingCR = true;
      return;
    }
    if (char === '\n') return endLine(true);
    if (lineLength < 3) delimiter += char;
    else if (char !== ' ' && char !== '\t') cleanTail = false;
    lineLength++;
    if (mode === 'frontmatter') return;
    if (!nonblank && (char === ' ' || char === '\t')) {
      leading += char === '\t' ? 4 - (leading % 4) : 1;
      return;
    }
    if (!nonblank) {
      nonblank = true;
      opening = mode === 'first' && leading === 0 && char === '-';
    }
    if (opening) {
      if (openingCount < 3) {
        if (char !== '-') return false;
        openingCount++;
        return;
      }
      return char === ' ' || char === '\t' ? undefined : false;
    }
    if (leading > 3) return false;
    if (prefix.length < declaration.length) {
      if (char !== declaration[prefix.length]) return false;
      prefix += char;
      return;
    }
    return !/\w/.test(char);
  };
  return {
    push(bytes: Uint8Array): boolean | undefined {
      for (const char of decoder.decode(bytes, { stream: true })) {
        const result = consume(char);
        if (result !== undefined) return result;
      }
    },
    finish(): boolean {
      for (const char of decoder.decode()) {
        const result = consume(char);
        if (result !== undefined) return result;
      }
      if (pendingCR) {
        const result = endLine(false);
        if (result !== undefined) return result;
      }
      return mode !== 'frontmatter' && nonblank && !opening && prefix === declaration;
    },
  };
}
export async function scanDiagramDeclaration(chunks: AsyncIterable<Uint8Array>): Promise<boolean> {
  const scanner = declarationScanner();
  for await (const bytes of chunks) {
    const result = scanner.push(bytes);
    if (result !== undefined) return result;
  }
  return scanner.finish();
}
export function hasDiagramDeclaration(file: string, signal?: AbortSignal) {
  return scanDiagramDeclaration(readBlocks(file, 0, undefined, signal));
}
export function hasDiagramDeclarationSync(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) fail(400, 'INVALID_PATH');
    // Candidate detection streams ordinary large files; graph readers apply their own size bound.
    const scanner = declarationScanner(),
      bytes = Buffer.allocUnsafe(limits.io);
    let length: number;
    while ((length = readSync(fd, bytes)) > 0) {
      const result = scanner.push(bytes.subarray(0, length));
      if (result !== undefined) return result;
    }
    return scanner.finish();
  } finally {
    closeSync(fd);
  }
}
