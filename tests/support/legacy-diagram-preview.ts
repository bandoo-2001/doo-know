import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { diagramRendererVersions } from '../../shared/diagram-primary';
import type { Fixture, loginFixtureOwner } from './fixture';
/** Prepare through the same owner HTTP path as the browser, without rewriting a legacy scene. */
export async function prepareLegacyPreview(
  f: Fixture,
  headers: Awaited<ReturnType<typeof loginFixtureOwner>>,
  id: string,
) {
  const resource = await f.app.inject({ url: `/api/notes/${id}/diagram`, headers });
  expect(resource.statusCode, resource.body).toBe(200);
  const { documentHash, source } = resource.json();
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/notes/${id}/diagram/legacy-preview`,
    headers,
    payload: {
      expectedDocumentHash: documentHash,
      expectedSourceHash: source.hash,
      pngBase64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
      renderer: diagramRendererVersions.whiteboard,
      config: {},
      requestId: randomUUID(),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
