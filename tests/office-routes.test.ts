import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { expect, it } from 'vitest';
import { officeFormats, type OfficeFormat } from '../packages/core/office/formats.js';
import { extractIndexedOfficeText } from '../packages/core/office/extract.js';
import { pdfOcrConfiguration } from '../packages/core/office/pdf-ocr.js';
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

function multipart(name: string, bytes: Buffer) {
  return Buffer.concat([
    Buffer.from(
      `--office-test\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n`,
    ),
    bytes,
    Buffer.from('\r\n--office-test--\r\n'),
  ]);
}
const form = { 'content-type': 'multipart/form-data; boundary=office-test' };

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
  const f = await createFixture({ indexing: { watch: false } });
  try {
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
    const enabled = await f.app.inject({
      method: 'PUT',
      url: '/api/platform/mcp/enabled',
      headers,
      payload: { enabled: true },
    });
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
        url: '/api/office/documents?folder=00-Inbox',
        headers: { ...headers, ...form },
        payload: multipart(name, bytes),
      });
    for (const fileType of formats) {
      const name = `Recovery.${fileType}`;
      const scannedPdf = fileType === 'pdf' ? scan : undefined;
      const query = scannedPdf ? scanTerm : originalMarker(fileType);
      const inputBytes = scannedPdf ?? officeFile(fileType, query);
      const original = await upload(name, inputBytes);
      expect(original.statusCode, original.body).toBe(201);
      const { id, relativePath } = original.json();
      expect(relativePath).toBe('00-Inbox/' + name);
      expect(await readFile(join(f.knowledgeRoot, relativePath))).toEqual(inputBytes);
      const tree = await f.app.inject({ url: '/api/tree', headers });
      expect(tree.json()).toContainEqual(
        expect.objectContaining({
          path: '00-Inbox',
          children: expect.arrayContaining([
            expect.objectContaining({ type: 'office', id, path: relativePath, name }),
          ]),
        }),
      );
      const collision = await upload(name, officeFile(fileType, 'same name'));
      expect(collision.statusCode).toBe(409);
      expect(await readFile(join(f.knowledgeRoot, relativePath))).toEqual(inputBytes);
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

      const read = await f.app.inject({ url: downloadPath, headers });
      expect(read.headers['content-type']).toBe(officeFormats[fileType].mime);
      const save = (text: string) =>
        f.app.inject({
          method: 'PUT',
          url: `/api/office/documents/${id}`,
          headers: { ...headers, ...form, 'if-match': String(read.headers.etag) },
          payload: multipart(name, officeFile(fileType, text)),
        });
      const saved = await save(updatedMarker(fileType));
      if (fileType === 'pdf' || fileType === 'pptx') {
        expect(saved.statusCode).toBe(405);
        expect((await f.app.inject({ url: downloadPath, headers })).rawPayload).toEqual(inputBytes);
        continue;
      }
      expect(saved.statusCode, saved.body).toBe(200);
      expect((await save(updatedMarker(fileType))).statusCode).toBe(200);
      expect((await save('another revision')).statusCode).toBe(409);
      expect((await tool('search', { query })).results).toEqual([]);
      expect((await rpc('fetch', { id: result.id })).structuredContent).toMatchObject({
        error: { code: 'RESULT_STALE' },
      });
      const updated = updatedMarker(fileType);
      await waitForDocument(updated, name);
      const current = (await tool('search', { query: updated })).results[0];
      expect(current.url).toBe(result.url);
      const replacement = await tool('fetch', { id: current.id });
      expect(replacement.text).toContain(updated);
      expect(replacement.metadata.documentId).toBe(id);
      expect(replacement.metadata.sourceRevision).toBeGreaterThan(found.metadata.sourceRevision);
      expect((await f.app.inject({ url: downloadPath, headers })).rawPayload).toEqual(
        officeFile(fileType, updated),
      );
    }
  } finally {
    await f.close();
  }
}, 45_000);

it('opens the original library in place and rejects incomplete or mismatched saves', async () => {
  const f = await createFixture({ indexing: { watch: false } });
  try {
    const headers = await loginFixtureOwner(f);
    const id = randomUUID();
    const legacy = join(f.knowledgeRoot, '_doo-data/apps/onlyoffice/documents', id);
    const original = docx('Existing note');
    await mkdir(legacy, { recursive: true });
    await writeFile(
      join(legacy, 'metadata.json'),
      JSON.stringify({ format: 1, name: 'Legacy.docx' }),
    );
    await writeFile(join(legacy, 'document.docx'), original);
    const tree = await f.app.inject({ url: '/api/tree', headers });
    expect(tree.json()).toContainEqual(
      expect.objectContaining({ type: 'office', id, name: 'Legacy.docx' }),
    );
    const list = await f.app.inject({ url: '/api/office/documents', headers });
    expect(list.json().documents).toContainEqual(
      expect.objectContaining({ id, name: 'Legacy.docx', fileType: 'docx' }),
    );
    const url = '/api/office/documents/' + id;
    const read = await f.app.inject({ url: url + '/download', headers });
    const payload = multipart('Legacy.docx', officeFile('xlsx', 'wrong format'));
    expect(
      (await f.app.inject({ method: 'PUT', url, headers: { ...headers, ...form }, payload }))
        .statusCode,
    ).toBe(428);
    const invalid = await f.app.inject({
      method: 'PUT',
      url,
      headers: { ...headers, ...form, 'if-match': String(read.headers.etag) },
      payload,
    });
    expect(invalid.statusCode).toBe(400);
    expect(await readFile(join(legacy, 'document.docx'))).toEqual(original);
  } finally {
    await f.close();
  }
});
