import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { processRunner } from '../processes/runner.js';
import { maxOfficeFileBytes } from './formats.js';

const defaultLanguages = 'chi_sim+eng';
const defaultMaxPages = 32;
const maxDocumentTime = 90_000;
const maxRasterTime = 8_000;
const maxRecognitionTime = 12_000;
const maxRasterDimension = 2400;
const maxRasterBytes = 8 * 1024 * 1024;
const maxPageTextBytes = 64 * 1024;
const maxDocumentTextBytes = 512 * 1024;
const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex');
const subprocessEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  OMP_THREAD_LIMIT: '1',
};

export type PdfOcrConfiguration = Readonly<{
  enabled: boolean;
  available: boolean;
  cacheKey: string;
  pdftoppm?: string;
  tesseract?: string;
  languages: string;
  tessdata?: string;
  maxPages: number;
}>;
export type PdfOcrResult = {
  pages: { page: number; text: string }[];
  unavailable: boolean;
  incomplete: boolean;
};

function program(override: string | undefined, name: string, path: string | undefined) {
  const directories = (path ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter);
  const candidates =
    override === undefined
      ? directories.filter(isAbsolute).map((directory) => join(directory, name))
      : [override];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const resolved = realpathSync(candidate);
      if (!statSync(resolved).isFile()) continue;
      accessSync(resolved, constants.X_OK);
      return resolved;
    } catch {
      // Optional dependencies may be absent from the deployment.
    }
  }
}

function fileIdentity(file: string | undefined) {
  if (!file) return null;
  try {
    const info = statSync(file, { bigint: true });
    if (!info.isFile() || info.size <= 0n) return null;
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return null;
  }
}

function languagePath(tessdata: string | undefined) {
  return tessdata ? ['--tessdata-dir', tessdata] : [];
}

function inspectConfiguration(env: NodeJS.ProcessEnv): PdfOcrConfiguration {
  const enabled = env.DOOKNOW_PDF_OCR_ENABLED !== '0';
  const languages = env.DOOKNOW_PDF_OCR_LANGUAGES || defaultLanguages;
  const requestedPageLimit = Number(env.DOOKNOW_PDF_OCR_MAX_PAGES);
  const maxPages =
    Number.isInteger(requestedPageLimit) && requestedPageLimit >= 1 && requestedPageLimit <= 128
      ? requestedPageLimit
      : defaultMaxPages;
  if (!enabled)
    return Object.freeze({ enabled, available: false, cacheKey: 'off', languages, maxPages });

  const pdftoppm = program(env.DOOKNOW_PDF_OCR_PDFTOPPM || undefined, 'pdftoppm', env.PATH);
  const tesseract = program(env.DOOKNOW_PDF_OCR_TESSERACT || undefined, 'tesseract', env.PATH);
  const tessdata = env.DOOKNOW_PDF_OCR_TESSDATA || undefined;
  const validLanguages = /^[a-zA-Z0-9_]{1,32}(?:\+[a-zA-Z0-9_]{1,32}){0,7}$/.test(languages);
  let available = false;
  let detectedTessdata: string | undefined;
  let modelIdentities: (string | null)[] = [];
  if (pdftoppm && tesseract && validLanguages && (tessdata === undefined || isAbsolute(tessdata))) {
    try {
      const stdout = execFileSync(
        processRunner(),
        ['--', tesseract, '--list-langs', ...languagePath(tessdata)],
        {
          cwd: '/',
          env: subprocessEnv,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
          killSignal: 'SIGKILL',
          maxBuffer: 32 * 1024,
        },
      );
      const [header, ...models] = stdout.trim().split(/\r?\n/);
      const listed = new Set(models.map((model) => model.trim()));
      const selected = languages.split('+');
      available = selected.every((lang) => listed.has(lang));
      const modelsPath =
        tessdata ?? /^List of available languages in "(.*)" \(\d+\):$/.exec(header)?.[1];
      detectedTessdata = modelsPath;
      if (modelsPath && isAbsolute(modelsPath))
        modelIdentities = selected.map((lang) =>
          fileIdentity(join(modelsPath, `${lang}.traineddata`)),
        );
    } catch {
      // Tool failures and host-specific paths do not enter search diagnostics.
    }
  }
  const cacheKey = createHash('sha256')
    .update(
      JSON.stringify({
        profile: 1,
        available,
        languages,
        maxPages,
        pdftoppm,
        pdftoppmIdentity: fileIdentity(pdftoppm),
        tesseract,
        tesseractIdentity: fileIdentity(tesseract),
        tessdata,
        detectedTessdata,
        modelIdentities,
      }),
    )
    .digest('hex');
  return Object.freeze({
    enabled,
    available,
    cacheKey,
    pdftoppm,
    tesseract,
    tessdata,
    languages,
    maxPages,
  });
}

let activeConfiguration: { environment: string; value: PdfOcrConfiguration } | undefined;
export function pdfOcrConfiguration(env = process.env): PdfOcrConfiguration {
  if (env !== process.env) return inspectConfiguration(env);
  const environment = JSON.stringify([
    env.DOOKNOW_PDF_OCR_ENABLED,
    env.DOOKNOW_PDF_OCR_LANGUAGES,
    env.DOOKNOW_PDF_OCR_MAX_PAGES,
    env.DOOKNOW_PDF_OCR_PDFTOPPM,
    env.DOOKNOW_PDF_OCR_TESSERACT,
    env.DOOKNOW_PDF_OCR_TESSDATA,
    env.PATH,
  ]);
  if (activeConfiguration?.environment !== environment)
    activeConfiguration = { environment, value: inspectConfiguration(env) };
  return activeConfiguration.value;
}

function runTool(
  runner: string,
  binary: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  maxBytes: number,
  input?: Buffer,
): Promise<Buffer | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(runner, ['--', binary, ...args], {
        cwd,
        detached: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...subprocessEnv, TMPDIR: cwd },
      });
    } catch {
      resolve(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const stopGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The tool and its process group may already have exited.
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed) return;
      if (bytes + chunk.length > maxBytes) {
        failed = true;
        stopGroup();
        return;
      }
      bytes += chunk.length;
      chunks.push(chunk);
    });
    child.on('error', () => {
      failed = true;
    });
    child.stdin.on('error', () => {});
    // Descendants cannot escape the process group. Close their pipes even if
    // the main process exited before them.
    child.once('exit', stopGroup);
    child.once('close', (code) => {
      signal.removeEventListener('abort', stopGroup);
      resolve(code === 0 && !failed && !signal.aborted ? Buffer.concat(chunks, bytes) : undefined);
    });
    signal.addEventListener('abort', stopGroup, { once: true });
    if (signal.aborted) stopGroup();
    child.stdin.end(input);
  });
}

function validRaster(bytes: Buffer | undefined): bytes is Buffer {
  if (
    !bytes ||
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(pngHeader) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return (
    width > 0 && height > 0 && width <= maxRasterDimension + 1 && height <= maxRasterDimension + 1
  );
}

export async function recognizePdfPages(
  bytes: Buffer,
  pages: readonly number[],
  config = pdfOcrConfiguration(),
  options: { signal?: AbortSignal } = {},
): Promise<PdfOcrResult> {
  options.signal?.throwIfAborted();
  const result: PdfOcrResult = { pages: [], unavailable: false, incomplete: false };
  if (!config.enabled || !pages.length) return result;
  const { pdftoppm, tesseract } = config;
  if (!config.available || !pdftoppm || !tesseract) return { ...result, unavailable: true };
  const selected = [...new Set(pages)].sort((left, right) => left - right);
  const validPages = selected.filter((page) => Number.isInteger(page) && page >= 1 && page <= 512);
  const work = validPages.slice(0, config.maxPages);
  result.incomplete = work.length !== selected.length;
  if (!work.length || !bytes.length || bytes.length > maxOfficeFileBytes)
    return { ...result, incomplete: true };

  const signals = [
    AbortSignal.timeout(maxDocumentTime),
    ...(options.signal ? [options.signal] : []),
  ];
  const overall = AbortSignal.any(signals);
  let directory: string | undefined;
  try {
    let runner;
    try {
      runner = processRunner();
    } catch {
      return { ...result, unavailable: true };
    }
    directory = await mkdtemp(join(tmpdir(), 'dooknow-pdf-ocr-'));
    const source = join(directory, 'input.pdf');
    await writeFile(source, bytes, { flag: 'wx', mode: 0o600 });
    let remaining = maxDocumentTextBytes;
    for (const page of work) {
      if (overall.aborted || !remaining) {
        result.incomplete = true;
        break;
      }
      const pageArgument = String(page);
      const png = await runTool(
        runner,
        pdftoppm,
        [
          '-f',
          pageArgument,
          '-l',
          pageArgument,
          '-singlefile',
          '-gray',
          '-png',
          '-scale-to',
          String(maxRasterDimension),
          '-q',
          source,
        ],
        directory,
        AbortSignal.any([overall, AbortSignal.timeout(maxRasterTime)]),
        maxRasterBytes,
      );
      const output = validRaster(png)
        ? await runTool(
            runner,
            tesseract,
            [
              'stdin',
              'stdout',
              ...languagePath(config.tessdata),
              '-l',
              config.languages,
              '--dpi',
              '200',
            ],
            directory,
            AbortSignal.any([overall, AbortSignal.timeout(maxRecognitionTime)]),
            Math.min(remaining, maxPageTextBytes),
            png,
          )
        : undefined;
      if (!output) {
        result.incomplete = true;
        continue;
      }
      const text = output
        .toString('utf8')
        .replace(/(?<=\p{Script=Han})[\t\p{Zs}]+(?=\p{Script=Han})/gu, '')
        .trim();
      remaining -= output.length;
      if (text) result.pages.push({ page, text });
    }
  } catch {
    result.incomplete = true;
  } finally {
    if (directory)
      await rm(directory, { recursive: true, force: true, maxRetries: 2 }).catch(() => {
        result.incomplete = true;
      });
  }
  options.signal?.throwIfAborted();
  return result;
}
