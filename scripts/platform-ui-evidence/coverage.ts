import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Scene } from './model';

const root = 'docs/design/platform-unification-2026-11-05';
async function evidenceExclusions() {
  const path = root + '/runtime/historical-state-exclusions.json';
  const bytes = await readFile(resolve(path)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  const entries: any[] = bytes ? JSON.parse(bytes.toString()).entries : [];
  return { path, sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
    entries, byKey: new Map(entries.map(entry => [entry.runId + ':' + entry.evidenceId, entry])) };
}
export async function inputs() {
  const paths = ['coverage/workspace.json', 'coverage/settings.json', 'coverage/public-and-blog.json',
    'coverage/runtime-diagrams.json', 'verification-plan.json', 'design/catalog.json'];
  const values = await Promise.all(paths.map(async path => {
    const bytes = await readFile(resolve(root, path));
    return { path: `${root}/${path}`, sha256: createHash('sha256').update(bytes).digest('hex'), value: JSON.parse(bytes.toString()) };
  }));
  const catalog = values[5].value;
  const sources = values.slice(0, 3).flatMap(x => x.value.surfaces);
  const runtimeSources = values[3].value.surfaces;
  return { sources, runtimeSources, catalog, fingerprints: values.map(({ path, sha256 }) => ({ path, sha256 })) };
}

export async function matrix(scenes: Scene[], records: any[]) {
  const { sources, runtimeSources, catalog, fingerprints } = await inputs();
  const exclusions = await evidenceExclusions();
  const effectiveRecords = records.map(record => {
    const exclusion = exclusions.byKey.get(record.runId + ':' + record.id);
    return exclusion ? { ...record, originalStatus: record.status, status: 'historical-state-not-accepted-needs-recapture',
      runtimeEvidence: false, exclusionReason: exclusion.reason } : record;
  });
  const outputs = new Map<string, any>(catalog.outputs.map((x: any) => [x.id, x]));
  const sourceMap = new Map<string, any>(catalog.coverage.map((x: any) => [x.sourceId, x]));
  function row(source: any, supplement = false) {
    const design = sourceMap.get(source.id);
    const canonicalMappings = (source.canonicalRefs ?? []).flatMap((canonicalSourceId: string) =>
      (sourceMap.get(canonicalSourceId)?.mappings ?? []).map((mapping: any) => ({ ...mapping, canonicalSourceId,
        mappingOrigin: 'vendor-supplement-to-host-composition; not a separate runtime/design approval' })));
    const planned = scenes.filter(scene => scene.sourceIds.includes(source.id));
    const attempts = effectiveRecords.filter(record => record.sourceIds?.includes(source.id));
    const captured = attempts.filter(record => record.status === 'captured');
    const status = design?.dormant ? 'dormant-unmounted'
      : source.id === 'PB-060' ? 'nonvisual-http'
      : source.id === 'PB-016' ? 'conditional-source-only'
      : !planned.length ? 'untested-no-recipe'
      : !attempts.length ? 'planned-not-run'
      : captured.length ? 'runtime-captured-review-pending'
      : attempts.every(record => record.status === 'unavailable') ? 'unavailable'
      : attempts.every(record => record.status === 'historical-state-not-accepted-needs-recapture') ? 'state-mismatch-needs-recapture'
      : 'runtime-failure';
    return {
      sourceId: source.id, title: source.title, kind: source.kind ?? 'vendor-runtime-supplement',
      status, supplement, roles: source.roles ?? ['authenticated owner'],
      sourceRefs: source.sourceRefs, permissionRules: source.permissionRules ?? [],
      canonicalRefs: source.canonicalRefs ?? [], runtimeContract: supplement ? { labels: source.actualDOMLabels, constraints: source.constraints } : null,
      entry: source.entry ?? null, fields: source.fields ?? [], actions: source.actions ?? [], testRefs: source.testRefs ?? [],
      reachability: source.reachability ?? null,
      designMappings: (design?.mappings ?? canonicalMappings).map((mapping: any) => ({ ...mapping,
        current: outputs.get(mapping.assetId)?.current ?? null })),
      stateMappings: design?.stateMappings ?? [],
      plannedScenes: planned.map(scene => scene.id), attempts: attempts.map(record => record.id),
      attemptResults: attempts.map(record => ({ evidenceId: record.id, sceneId: record.sceneId, state: record.state,
        runId: record.runId, viewport: record.viewport, theme: record.theme, status: record.status, originalStatus: record.originalStatus,
        exclusionReason: record.exclusionReason ?? null, probeStatus: record.probeStatus,
        readinessAssertions: record.readinessAssertions ?? [], error: record.error ?? null })),
      capturedWidths: [...new Set(captured.map(record => record.viewport.width))],
      missingRequiredWidths: [1440, 390, 320].filter(width => !captured.some(record => record.viewport.width === width)),
      importantStates: (source.importantStates ?? []).map((state: string) => {
        const exactScenes = planned.filter(scene => scene.importantStates?.[source.id]?.includes(state));
        const evidence = captured.filter(record => exactScenes.some(scene => scene.id === record.sceneId));
        return { state, status: evidence.length ? 'runtime-captured-review-pending' : 'untested',
          evidence: evidence.map(record => record.id),
          designMappings: (design?.stateMappings ?? []).filter((mapping: any) => mapping.state === state) };
      }),
      // Family capture is deliberately insufficient to clear every state contract.
      visualComparison: 'pending-human-or-independent-runtime-review',
      hardwareVerification: 'not-verified-physical-soft-keyboard-native-picker-print-external-delivery',
      reason: supplement ? 'Vendor supplement retained separately from canonical source coverage.'
        : design?.dormant ? 'Frozen catalog marks the source dormant; a different mounted surface is not evidence.'
        : source.id === 'PB-060' ? 'HTTP response has no app-owned visual error page; record status/code separately.'
        : source.id === 'PB-016' ? 'Normal route reachability is not established; no synthetic mount.'
        : !planned.length ? 'No genuine runtime recipe supplied; source/design evidence does not count as runtime.' : null,
    };
  }
  const rows = [...sources.map((source: any) => row(source)), ...runtimeSources.map((source: any) => row(source, true))];
  return { schema: 1, kind: 'actual-runtime-coverage', generatedAt: new Date().toISOString(), inputFingerprints: fingerprints,
    historicalExclusions: { path: exclusions.path, sha256: exclusions.sha256 },
    excludedEvidence: effectiveRecords.filter(record => record.runtimeEvidence === false && record.exclusionReason).map(record => ({
      runId: record.runId, id: record.id, status: record.status, originalStatus: record.originalStatus, reason: record.exclusionReason,
      file: record.file, sha256: record.sha256, sourceIds: record.sourceIds,
    })),
    summary: rows.reduce((result: Record<string, number>, item: any) => ({ ...result, [item.status]: (result[item.status] ?? 0) + 1 }), {}),
    sources: rows };
}

export async function writeMatrix(directory: string, scenes: Scene[], records: any[]) {
  await mkdir(directory, { recursive: true });
  const value = await matrix(scenes, records);
  await writeFile(resolve(directory, 'source-coverage.json'), JSON.stringify(value, null, 2) + '\n');
  await writeFile(resolve(directory, 'missing-recipes.json'), JSON.stringify(value.sources.filter((source: any) =>
    source.status === 'untested-no-recipe' || source.importantStates.some((state: any) => state.status === 'untested')).map((source: any) => ({
      sourceId: source.sourceId, title: source.title, kind: source.kind, status: source.status,
      familyRecipeMissing: source.status === 'untested-no-recipe', entry: source.entry, roles: source.roles,
      sourceRefs: source.sourceRefs, testRefs: source.testRefs, fields: source.fields, actions: source.actions,
      missingStateBranches: source.importantStates.filter((state: any) => state.status === 'untested').map((state: any) => state.state),
      existingScenes: source.plannedScenes, designMappings: source.designMappings,
    })), null, 2) + '\n');
  const excludedKeys = new Set(value.excludedEvidence.map(record => record.runId + ':' + record.id));
  await writeFile(resolve(directory, 'invalidated-evidence.json'), JSON.stringify(value.excludedEvidence, null, 2) + '\n');
  await writeFile(resolve(directory, 'review-queue.json'), JSON.stringify(records.filter(x => x.status === 'captured' && !excludedKeys.has(x.runId + ':' + x.id)).map(x => ({
    evidenceId: x.id, runtimePNG: x.file, runtimeSHA256: x.sha256, sourceIds: x.sourceIds,
    role: x.role, state: x.state, viewport: x.viewport, theme: x.theme, designAssets: x.designAssets,
    checks: { composition: 'pending', actualDataAndConstraints: 'pending', themeAndBrand: 'pending',
      targetReachability: x.probeStatus, primaryAction: x.interactionResult ?? 'untested', screenshotInspection: 'pending' },
    reviewer: null, reviewedAt: null, findings: [],
  })), null, 2) + '\n');
  return value;
}
