import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { jwtVerify, SignJWT } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import { officeFormats, type OfficeFormat } from '../packages/core/onlyoffice/formats.js';
import { extractIndexedOfficeText } from '../packages/core/onlyoffice/extract.js';
import { pdfOcrConfiguration } from '../packages/core/onlyoffice/pdf-ocr.js';
import { createFixture, loginFixtureOwner } from './support/fixture.js';

function docx(text: string) {
  return packageBytes([
    [
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="word/document.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ]);
}

function packageBytes(entries: [string, string][]) {
  const data: Buffer[] = [],
    directory: Buffer[] = [];
  let size = 0,
    centralSize = 0;
  for (const [filename, content] of entries) {
    const name = Buffer.from(filename),
      bytes = Buffer.from(content);
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(size, 42);
    data.push(local, name, bytes);
    directory.push(central, name);
    size += local.length + name.length + bytes.length;
    centralSize += central.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(size, 16);
  return Buffer.concat([...data, ...directory, end]);
}

function pdf(text: string) {
  const stream = `BT /F1 12 Tf 20 50 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 80] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.7\n';
  const offsets = objects.map((value, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${value}\nendobj\n`;
    return String(offset).padStart(10, '0');
  });
  const crossRef = body.length;
  return Buffer.from(
    `${body}xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${offset} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${crossRef}\n%%EOF\n`,
  );
}

function officeFile(type: OfficeFormat, text: string) {
  if (type === 'docx') return docx(text);
  if (type === 'pdf') return pdf(text);
  const workbook = type === 'xlsx';
  const entry = workbook ? 'xl/workbook.xml' : 'ppt/presentation.xml';
  const contentType = workbook ? 'spreadsheetml.sheet' : 'presentationml.presentation';
  const documentRels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const target = workbook ? 'worksheets/sheet1.xml' : 'slides/slide1.xml';
  return packageBytes([
    [
      '[Content_Types].xml',
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${entry}" ContentType="application/vnd.openxmlformats-officedocument.${contentType}.main+xml"/></Types>`,
    ],
    [
      entry,
      workbook
        ? `<workbook xmlns="${spreadsheet}" xmlns:r="${documentRels}"><sheets><sheet name="Recovery sheet" sheetId="1" r:id="rId1"/></sheets></workbook>`
        : `<p:presentation xmlns:p="${presentation}" xmlns:r="${documentRels}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    ],
    [
      workbook ? 'xl/_rels/workbook.xml.rels' : 'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="${packageRels}"><Relationship Id="rId1" Type="${documentRels}/${workbook ? 'worksheet' : 'slide'}" Target="${target}"/></Relationships>`,
    ],
    [
      (workbook ? 'xl/' : 'ppt/') + target,
      workbook
        ? `<worksheet xmlns="${spreadsheet}"><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`
        : `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ],
  ]);
}

afterEach(() => vi.unstubAllEnvs());

it('serves the latest native Office text and owner-only originals through packaged MCP', async () => {
  const formats = ['docx', 'xlsx', 'pptx', 'pdf'] as const;
  const scanPath = process.env.DOOKNOW_TEST_SCAN_PDF;
  const scan = scanPath ? await readFile(scanPath) : undefined;
  const scanTerm = process.env.DOOKNOW_TEST_SCAN_TERM || '备用电源检查';
  const scanPage = process.env.DOOKNOW_TEST_SCAN_PAGE || '2';
  if (scan) {
    const withoutOcr = await extractIndexedOfficeText(scan, 'pdf', {
      ocrConfiguration: pdfOcrConfiguration({ DOOKNOW_PDF_OCR_ENABLED: '0' }),
    });
    expect(withoutOcr.segments).toEqual([]);
  }
  const updatedMarker = (type: OfficeFormat) => `officeupdated${type}`;
  const originalMarker = (type: OfficeFormat) => `officeoriginal${type}`;
  const editor = createServer((request, response) => {
    const type = formats.find((entry) => request.url === `/changed.${entry}`);
    if (!type) return response.writeHead(404).end();
    response.end(officeFile(type, updatedMarker(type)));
  });
  await new Promise<void>((resolve) => editor.listen(0, '127.0.0.1', resolve));
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  const officeKey = 'office-index-fixture-key-at-least-thirty-two-characters';
  try {
    const editorUrl = `http://127.0.0.1:${(editor.address() as { port: number }).port}`;
    vi.stubEnv('DOOKNOW_ONLYOFFICE_URL', editorUrl);
    vi.stubEnv('DOOKNOW_ONLYOFFICE_INTERNAL_URL', undefined);
    vi.stubEnv('DOOKNOW_ONLYOFFICE_APP_URL', undefined);
    vi.stubEnv('DOOKNOW_ONLYOFFICE_JWT_SECRET_FILE', undefined);
    vi.stubEnv('DOOKNOW_ONLYOFFICE_JWT_SECRET', officeKey);
    const f = (fixture = await createFixture({
      indexing: { watch: false },
    }));
    const headers = await loginFixtureOwner(f);
    const post = (url: string, payload: Record<string, unknown> = {}) =>
      f.app.inject({ method: 'POST', url, headers, payload });
    const { mcp } = (await f.app.inject({ url: '/api/platform/features', headers })).json();
    const permission = await f.app.inject({ url: '/api/platform/mcp/permissions', headers });
    expect(permission.statusCode, permission.body).toBe(200);
    const policy = permission.json().policy;
    policy.domains.knowledge.resources = { mode: 'all' };
    const externalWebOrigin = 'https://office-research.example';
    const configured = await f.app.inject({
      method: 'PUT',
      url: '/api/platform/mcp/config',
      headers,
      payload: {
        configVersion: mcp.configVersion,
        values: { externalWebOrigin, permissionPolicy: policy },
      },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    const enabled = await f.app.inject({ method: 'PUT', url: '/api/platform/mcp/enabled', headers, payload: { enabled: true } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const owner = await post('/api/platform/mcp/api-clients', {
      name: 'Full library fixture',
      permissionPolicy: policy,
    });
    expect(owner.statusCode).toBe(200);
    const note = await post('/api/notes', {
      folderPath: '00-Inbox',
      fileName: 'Scoped note.md',
      content: '# Scoped note\n\nMarkdown remains searchable.',
    });
    expect(note.statusCode, note.body).toBe(201);
    const scoped = structuredClone(policy);
    scoped.domains.knowledge.resources = {
      mode: 'selected',
      resources: [{ kind: 'note', id: note.json().id }],
    };
    const reader = await post('/api/platform/mcp/api-clients', {
      name: 'Selected note fixture',
      permissionPolicy: scoped,
    });
    expect(reader.statusCode).toBe(200);
    let sequence = 0;
    const rpc = async (name: string, args: object, key = owner.json().key) => {
      const response = await f.app.inject({
        method: 'POST',
        url: '/mcp/api-key',
        headers: {
          host: new URL(f.config.origin).host,
          authorization: 'Bearer ' + key,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: ++sequence,
          method: 'tools/call',
          params: { name, arguments: args },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().result;
    };
    const tool = async (name: string, args: object, key?: string) => {
      const result = await rpc(name, args, key);
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
      return result.structuredContent;
    };
    async function waitForDocument(query: string, title: string) {
      let latest: unknown;
      try {
        await expect
          .poll(async () => (latest = await tool('search', { query })), {
            timeout: scan ? 20_000 : 8_000,
            interval: 250,
          })
          .toMatchObject({ results: [{ title }] });
      } catch (error) {
        throw new Error(`MCP search did not find ${title}: ${JSON.stringify(latest)}`, {
          cause: error,
        });
      }
    }
    const upload = (name: string, bytes: Buffer) =>
      f.app.inject({
        method: 'POST',
        url: '/api/office/documents',
        headers: { ...headers, 'content-type': 'multipart/form-data; boundary=office-research' },
        payload: Buffer.concat([
          Buffer.from(
            `--office-research\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n`,
          ),
          bytes,
          Buffer.from('\r\n--office-research--\r\n'),
        ]),
      });
    for (const fileType of formats) {
      const name = `Recovery.${fileType}`;
      const scannedPdf = fileType === 'pdf' ? scan : undefined;
      const query = scannedPdf ? scanTerm : originalMarker(fileType);
      const inputBytes = scannedPdf ?? officeFile(fileType, query);
      const original = await upload(name, inputBytes);
      expect(original.statusCode, original.body).toBe(201);
      const { id } = original.json();
      const downloadPath = `/api/office/documents/${id}/download`;
      const pdfViewPath = `/api/office/documents/${id}/view`;
      const page = scannedPdf ? scanPage : '1';
      const citationPath = fileType === 'pdf' ? `${pdfViewPath}#page=${page}` : downloadPath;
      await waitForDocument(query, name);
      const result = (await tool('search', { query })).results[0];
      expect(result.url).toBe(externalWebOrigin + citationPath);
      const found = await tool('fetch', { id: result.id });
      expect(found).toMatchObject({
        url: externalWebOrigin + citationPath,
        metadata: { documentId: id, objectType: 'office', fileType },
      });
      expect(found.text).toContain(query);
      expect((await f.app.inject({ url: downloadPath })).statusCode).toBe(401);
      if (fileType === 'pdf') {
        const viewPath = new URL(result.url).pathname;
        expect((await f.app.inject({ url: viewPath })).statusCode).toBe(401);
        const pdfView = await f.app.inject({ url: viewPath, headers });
        expect(pdfView.headers['content-disposition']).toMatch(/^inline;/);
        expect(pdfView.rawPayload).toEqual(inputBytes);
        expect(found.metadata.location).toBe(`第 ${page} 页`);
      }
      expect((await tool('search', { query }, reader.json().key)).results).toEqual([]);
      expect((await rpc('fetch', { id: result.id }, reader.json().key)).isError).toBe(true);

      const session = await post(`/api/office/documents/${id}/session`);
      expect(session.statusCode, session.body).toBe(200);
      const { config } = session.json();
      const callback = new URL(config.editorConfig.callbackUrl);
      const payload = {
        key: config.document.key,
        status: 6,
        url: `${editorUrl}/changed.${fileType}`,
      };
      const signature = await new SignJWT({ operation: 'callback', payload })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(Buffer.from(officeKey));
      const saved = await f.app.inject({
        method: 'POST',
        url: callback.pathname + callback.search,
        payload,
        headers: { authorization: 'Bearer ' + signature },
      });
      expect(saved.json(), saved.body).toEqual({ error: 0 });
      expect((await tool('search', { query })).results).toEqual([]);
      expect((await rpc('fetch', { id: result.id })).structuredContent).toMatchObject({
        error: { code: 'RESULT_STALE' },
      });
      const updated = updatedMarker(fileType);
      await waitForDocument(updated, name);
      const current = (await tool('search', { query: updated })).results[0];
      expect(current.url).toBe(
        fileType === 'pdf' ? `${externalWebOrigin}${pdfViewPath}#page=1` : result.url,
      );
      const replacement = await tool('fetch', { id: current.id });
      expect(replacement.text).toContain(updated);
      expect(replacement.metadata.documentId).toBe(id);
      expect(replacement.metadata.sourceRevision).toBeGreaterThan(found.metadata.sourceRevision);
      expect((await f.app.inject({ url: downloadPath, headers })).rawPayload).toEqual(
        officeFile(fileType, updated),
      );
    }
  } finally {
    await fixture?.close();
    await new Promise<void>((resolve, reject) =>
      editor.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 45_000);

it('can leave ONLYOFFICE disabled without creating Office data', async () => {
  vi.stubEnv('DOOKNOW_ONLYOFFICE_URL', undefined);
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const status = await f.app.inject({ url: '/api/office/status', headers });
    expect(status.json()).toEqual({ enabled: false });
    const documents = await f.app.inject({ url: '/api/office/documents', headers });
    expect(documents.json()).toEqual({ documents: [] });
  } finally {
    await f.close();
  }
});

it('opens and updates the stored DOCX with a signed force-save and final callback', async () => {
  const original = docx('original fixture');
  const forced = docx('forced save fixture');
  const final = docx('final save fixture');
  let downloads = 0;
  const editor = createServer((req, res) => {
    downloads++;
    res.end(req.url === '/force.docx' ? forced : final);
  });
  await new Promise<void>((resolve) => editor.listen(0, '127.0.0.1', resolve));
  const address = editor.address();
  if (typeof address !== 'object' || !address) throw new Error('editor mock has no socket');
  const browser = 'http://office.example.test/edit/';
  const officeKey = 'office-test-key-at-least-thirty-two-characters';
  const secret = Buffer.from(officeKey);
  vi.stubEnv('DOOKNOW_ONLYOFFICE_URL', browser);
  vi.stubEnv('DOOKNOW_ONLYOFFICE_INTERNAL_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('DOOKNOW_ONLYOFFICE_APP_URL', undefined);
  vi.stubEnv('DOOKNOW_ONLYOFFICE_JWT_SECRET_FILE', undefined);
  vi.stubEnv('DOOKNOW_ONLYOFFICE_JWT_SECRET', officeKey);
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const post = (url: string) => f.app.inject({ method: 'POST', url, headers });
    const pathOf = (value: string) => {
      const url = new URL(value);
      return url.pathname + url.search;
    };
    const signed = (data: object) =>
      new SignJWT({ operation: 'callback', payload: data })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(secret);
    const callback = async (url: string, body: object, token = signed(body)) =>
      f.app.inject({
        method: 'POST',
        url: pathOf(url),
        payload: body,
        headers: { authorization: 'Bearer ' + (await token) },
      });
    const upload = (bytes: Buffer) =>
      f.app.inject({
        method: 'POST',
        url: '/api/office/documents',
        headers: { ...headers, 'content-type': 'multipart/form-data; boundary=office-test' },
        payload: Buffer.concat([
          Buffer.from(
            '--office-test\r\nContent-Disposition: form-data; name="file"; filename="Original.docx"\r\n\r\n',
          ),
          bytes,
          Buffer.from('\r\n--office-test--\r\n'),
        ]),
      });

    expect((await f.app.inject({ url: '/api/office/status', headers })).json()).toEqual({
      enabled: true,
    });
    expect((await upload(Buffer.from('not a docx'))).statusCode).toBe(400);
    const uploaded = await upload(original);
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const { id } = uploaded.json();
    const originalPath = join(
      f.knowledgeRoot,
      `_doo-data/apps/onlyoffice/documents/${id}/document.docx`,
    );
    expect(await readFile(originalPath)).toEqual(original);
    const session = await post(`/api/office/documents/${id}/session`);
    expect(session.statusCode, session.body).toBe(200);
    const { editorUrl, config } = session.json();
    expect(editorUrl).toBe(browser);
    await expect(jwtVerify(config.token, secret)).resolves.toMatchObject({
      payload: { documentType: 'word', document: { key: config.document.key } },
    });
    expect(config.editorConfig.customization.forcesave).toBe(true);
    const machineFile = pathOf(config.document.url);
    expect((await f.app.inject({ url: machineFile.split('?')[0] })).statusCode).toBe(401);
    expect((await f.app.inject({ url: machineFile })).rawPayload).toEqual(original);

    const { callbackUrl } = config.editorConfig;
    const forceBody = { key: config.document.key, status: 6, url: `${browser}force.docx` };
    const changedBody = await callback(
      callbackUrl,
      { ...forceBody, url: `${browser}changed.docx` },
      signed(forceBody),
    );
    expect(changedBody.statusCode).toBe(401);
    const offsite = await callback(callbackUrl, {
      ...forceBody,
      url: 'http://127.0.0.1:1/other.docx',
    });
    expect(offsite.statusCode).toBe(400);
    expect(downloads).toBe(0);

    const saved = await callback(callbackUrl, forceBody);
    expect(saved.json(), saved.body).toEqual({ error: 0 });
    expect(await readFile(originalPath)).toEqual(forced);
    const stillOpen = (await post(`/api/office/documents/${id}/session`)).json().config;
    expect(stillOpen.document.key).toBe(config.document.key);
    const finalBody = { ...forceBody, status: 2, url: `${browser}final.docx` };
    expect((await callback(callbackUrl, finalBody)).json()).toEqual({ error: 0 });
    expect(await readFile(originalPath)).toEqual(final);
    expect((await callback(callbackUrl, forceBody)).json()).toEqual({ error: 0 });
    expect(downloads).toBe(2);
    const download = await f.app.inject({ url: `/api/office/documents/${id}/download`, headers });
    expect(download.rawPayload).toEqual(final);
    expect((await f.app.inject({ url: `/api/office/documents/${id}/download` })).statusCode).toBe(
      401,
    );
    const again = (await post(`/api/office/documents/${id}/session`)).json().config;
    expect(again.document.key).not.toBe(config.document.key);

    const external = docx('external update');
    await writeFile(originalPath, external);
    const stale = await callback(again.editorConfig.callbackUrl, {
      ...forceBody,
      key: again.document.key,
    });
    expect(stale.statusCode).toBe(409);
    expect(await readFile(originalPath)).toEqual(external);
  } finally {
    await f.close();
    await new Promise<void>((resolve, reject) =>
      editor.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('edits native spreadsheets, slides and PDF while preserving existing Word files', async () => {
  const formats = ['xlsx', 'pptx', 'pdf'] as const;
  const edits = new Map(formats.map((type) => [`/saved.${type}`, officeFile(type, 'edited')]));
  const editor = createServer((req, res) => {
    res.end(edits.get(req.url ?? '') ?? docx('wrong type'));
  });
  await new Promise<void>((resolve) => editor.listen(0, '127.0.0.1', resolve));
  const address = editor.address();
  if (typeof address !== 'object' || !address) throw new Error('editor mock has no socket');
  const editorUrl = `http://127.0.0.1:${address.port}`;
  const secret = 'office-test-key-at-least-thirty-two-characters';
  vi.stubEnv('DOOKNOW_ONLYOFFICE_URL', editorUrl);
  vi.stubEnv('DOOKNOW_ONLYOFFICE_INTERNAL_URL', undefined);
  vi.stubEnv('DOOKNOW_ONLYOFFICE_APP_URL', undefined);
  vi.stubEnv('DOOKNOW_ONLYOFFICE_JWT_SECRET_FILE', undefined);
  vi.stubEnv('DOOKNOW_ONLYOFFICE_JWT_SECRET', secret);
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const legacyId = randomUUID();
    const directory = join(f.knowledgeRoot, '_doo-data/apps/onlyoffice/documents');
    const legacy = join(directory, legacyId);
    const legacyBytes = docx('existing file');
    await mkdir(legacy, { recursive: true });
    const legacyMetadata = '{"format":1,"name":"Original.docx"}\n';
    await writeFile(join(legacy, 'metadata.json'), legacyMetadata);
    await writeFile(join(legacy, 'document.docx'), legacyBytes);
    const session = (id: string) =>
      f.app.inject({ method: 'POST', url: `/api/office/documents/${id}/session`, headers });
    expect((await session(legacyId)).json().config.document.fileType).toBe('docx');
    const upload = (name: string, bytes: Buffer) =>
      f.app.inject({
        method: 'POST',
        url: '/api/office/documents',
        headers: {
          ...headers,
          'content-type': 'multipart/form-data; boundary=office-formats-test',
        },
        payload: Buffer.concat([
          Buffer.from(
            `--office-formats-test\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n`,
          ),
          bytes,
          Buffer.from('\r\n--office-formats-test--\r\n'),
        ]),
      });
    expect((await upload('wrong.xlsx', legacyBytes)).statusCode).toBe(400);
    expect((await upload('wrong.pdf', Buffer.from('%PDF-1.7\nfake'))).statusCode).toBe(400);
    for (const fileType of formats) {
      const original = officeFile(fileType, 'original');
      const uploaded = await upload(`Original.${fileType}`, original);
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      const { id, fileType: actualType } = uploaded.json();
      expect(actualType).toBe(fileType);
      const originalPath = join(directory, id, `document.${fileType}`);
      expect(await readFile(originalPath)).toEqual(original);
      const opened = await session(id);
      expect(opened.statusCode, opened.body).toBe(200);
      const { config } = opened.json();
      expect(config).toMatchObject({
        documentType: officeFormats[fileType].documentType,
        document: { fileType },
      });
      const machineFile = new URL(config.document.url);
      const fromEditor = await f.app.inject({ url: machineFile.pathname + machineFile.search });
      expect(fromEditor.headers['content-type']).toBe(officeFormats[fileType].mime);
      expect(fromEditor.rawPayload).toEqual(original);
      const callback = new URL(config.editorConfig.callbackUrl);
      const save = async (filename: string) => {
        const payload = { key: config.document.key, status: 6, url: `${editorUrl}/${filename}` };
        const token = await new SignJWT({ operation: 'callback', payload })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuedAt()
          .sign(Buffer.from(secret));
        return f.app.inject({
          method: 'POST',
          url: callback.pathname + callback.search,
          headers: { authorization: `Bearer ${token}` },
          payload,
        });
      };
      const invalid = await save(`incorrect.${fileType}`);
      expect(invalid.statusCode, invalid.body).toBe(502);
      expect(await readFile(originalPath)).toEqual(original);
      const saved = await save(`saved.${fileType}`);
      expect(saved.json(), saved.body).toEqual({ error: 0 });
      expect(await readFile(originalPath)).toEqual(edits.get(`/saved.${fileType}`));
      const ownerDownload = await f.app.inject({
        url: `/api/office/documents/${id}/download`,
        headers,
      });
      expect(ownerDownload.headers['content-type']).toBe(officeFormats[fileType].mime);
      expect(ownerDownload.rawPayload).toEqual(edits.get(`/saved.${fileType}`));
      expect((await session(id)).json().config.document.key).toBe(config.document.key);
    }
    const list = await f.app.inject({ url: '/api/office/documents', headers });
    expect(list.json().documents).toHaveLength(4);
    expect(list.json().documents).toContainEqual(
      expect.objectContaining({ id: legacyId, fileType: 'docx' }),
    );
    expect(await readFile(join(legacy, 'metadata.json'), 'utf8')).toBe(legacyMetadata);
    expect(await readFile(join(legacy, 'document.docx'))).toEqual(legacyBytes);
  } finally {
    await f.close();
    await new Promise<void>((resolve, reject) =>
      editor.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
