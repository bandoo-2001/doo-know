import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { parseDiagramDocument } from '../shared/diagram-document';
import { localReference } from '../packages/core/render';
import { sha256 } from '../packages/core/knowledge/operations';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { organizationFixture } from './support/organization-fixture';
import { mutationCore, webPrincipal } from '../packages/core/knowledge/core';
import { diagramOperationPreviewRegistry } from '../packages/core/knowledge/diagram-operation-previews';
import { assetService } from '../packages/core/assets';

it('commits a prepared native-link move within the API budget beside large ordinary documents with image references', async () => {
  const f = organizationFixture();
  try {
    const corpus = 'Unrelated paragraph.\n\n'.repeat(60000);
    for (let n = 0; n < 24; n++)
      writeFileSync(join(f.config.knowledgeRoot, '00-Inbox', `plain-${n}.md`), corpus);
    const references = '# References\n\n![image](assets/example.png)\n\n' + '正文一行\n\n'.repeat(180000);
    const image = '# Large\n\n![image](_doo-assets/example.png)\n\n' + 'unchanged line\n'.repeat(160000);
    writeFileSync(join(f.config.knowledgeRoot, '00-Inbox', 'large-references.md'), references);
    writeFileSync(join(f.config.knowledgeRoot, '00-Inbox', 'large-image.md'), image);
    const source = JSON.stringify({
      type: 'excalidraw', version: 2,
      elements: [{ id: 'a', type: 'rectangle', link: '../../Topic/target.md' }],
      appState: {}, files: {},
    });
    const assets = assetService(f.config, f.db, f.notes);
    const primary = primaryDiagramService(f.config, f.db, f.notes, assets, webPrincipal);
    const intent = diagramCreationService(f.config, f.db, webPrincipal).reserve({path:'00-Inbox/board.md',type:'whiteboard',requestId:randomUUID()});
    const prepared = primary.prepare({target:{kind:'creation',intentId:intent.id},type:'whiteboard',source,sourceHash:sha256(source),title:'Board',renderer:diagramRendererVersions.whiteboard,config:{},pngBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',requestId:randomUUID()});
    const board = primary.commit({preparedId:prepared.id,markdown:renderPreparedDiagramDocument({prepared,title:'Board',source}),requestId:randomUUID()});
    const target = f.create('Topic/target.md', '# Target');
    const core = mutationCore(f.config, f.db);
    const registry = diagramOperationPreviewRegistry(f.config, f.db, webPrincipal, assetService(f.config, f.db, f.notes));
    const requestId = randomUUID();
    let details: any;
    try {
      core.move(webPrincipal, target.noteId, 'Topic', 'renamed.md', target.expectedModifiedAt, requestId);
    } catch (error) {
      expect(error).toMatchObject({ code: 'DIAGRAM_PREVIEW_REQUIRED' });
      details = (error as any).details;
    }
    expect(details.documents).toHaveLength(1);
    for (const need of details.documents) {
      const fixed = registry.get(need.snapshotId);
      registry.prepare(fixed.id, {
        sourceHash: fixed.sourceHash,
        pngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
        requestId: randomUUID(),
      });
    }
    const started = performance.now();
    const moved = core.move(webPrincipal, target.noteId, 'Topic', 'renamed.md', target.expectedModifiedAt, requestId);
    const elapsed = performance.now() - started;
    expect(moved).toMatchObject({ id: target.noteId, moved: true, relativePath: 'Topic/renamed.md' });
    expect(core.move(webPrincipal, target.noteId, 'Topic', 'renamed.md', target.expectedModifiedAt, requestId)).toEqual(moved);
    expect(f.notes.row(board.id).id).toBe(board.id);
    const parsed = parseDiagramDocument(readFileSync(join(f.config.knowledgeRoot, f.notes.row(board.id).path), 'utf8'));
    expect(parsed.status).toBe('diagram');
    if(parsed.status!=='diagram'||parsed.primary.source.format!=='excalidraw')throw Error('Missing native primary');
    const currentBoard=JSON.parse(readFileSync(join(f.config.knowledgeRoot,localReference(board.relativePath,parsed.primary.source.path)!), 'utf8'));
    expect(currentBoard.elements[0].link).toBe('../../Topic/renamed.md');
    for (let n = 0; n < 24; n++)
      expect(readFileSync(join(f.config.knowledgeRoot, '00-Inbox', `plain-${n}.md`), 'utf8')).toBe(corpus);
    expect(readFileSync(join(f.config.knowledgeRoot, '00-Inbox', 'large-references.md'), 'utf8')).toBe(references);
    expect(readFileSync(join(f.config.knowledgeRoot, '00-Inbox', 'large-image.md'), 'utf8')).toBe(image);
    expect(elapsed, 'The fixed corpus should retain its 15000 ms performance goal').toBeLessThan(15000);
  } finally {
    f.close();
  }
}, 120000);
