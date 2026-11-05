/** Static definition/index generation only: no server, browser or capture runner. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { allScenes, sceneGroups } from './registry';
import { variants } from './model';
import { inputs, writeMatrix } from './coverage';

const argument = process.argv.indexOf('--output');
const directory = resolve(argument >= 0 ? process.argv[argument + 1] : '.local/platform-ui-evidence-plan');
const source = await inputs();
const sources = new Map<string, any>([...source.sources, ...source.runtimeSources].map(item => [item.id, item]));
const issues: { sceneId: string; sourceId: string; issue: string; value?: string }[] = [];
for (const scene of allScenes) {
  for (const sourceId of scene.sourceIds) if (!sources.has(sourceId)) issues.push({ sceneId: scene.id, sourceId, issue: 'unknown-source-id' });
  for (const [sourceId, values] of Object.entries(scene.importantStates ?? {})) {
    if (!scene.sourceIds.includes(sourceId)) issues.push({ sceneId: scene.id, sourceId, issue: 'state-source-not-in-scene' });
    for (const state of values) if (!sources.get(sourceId)?.importantStates?.includes(state)) issues.push({ sceneId: scene.id, sourceId, issue: 'important-state-not-exact-inventory-string', value: state });
  }
}
await mkdir(directory, { recursive: true });
const matrix = await writeMatrix(directory, allScenes, []);
await writeFile(resolve(directory, 'capture-plan.json'), JSON.stringify({
  kind: 'static-planned-definitions-not-runtime', scenes: allScenes.map(({ before, open, verify, afterCapture, path, target, ...scene }) => ({
    ...scene, route: typeof path === 'string' ? path : '<isolated-fixture-route>', target: typeof target === 'string' ? target : '<role-selector>',
  })), variants,
}, null, 2) + '\n');
await writeFile(resolve(directory, 'definition-issues.json'), JSON.stringify(issues, null, 2) + '\n');
console.log(JSON.stringify({ kind: 'static-no-server-browser-runner', scenes: allScenes.length,
  groups: Object.fromEntries(Object.entries(sceneGroups).map(([group, scenes]) => [group, scenes.length])),
  sourceSummary: matrix.summary, definitionIssues: issues.length, directory }));
if (issues.length) process.exitCode = 1;
