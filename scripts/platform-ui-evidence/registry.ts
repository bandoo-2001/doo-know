import { scenes } from './scenes';
import { feedbackScenes } from './feedback-scenes';
import { settingsScenes } from './settings-scenes';
import { publicScenes } from './public-scenes';
import { workspaceScenes } from './workspace-scenes';
import { vendorScenes } from './vendor-scenes';
import { setupScenes } from './setup-scenes';
import { framingScenes } from './framing-scenes';

export const sceneGroups = { base: scenes, feedback: feedbackScenes, settings: settingsScenes, public: publicScenes,
  workspace: workspaceScenes, vendor: vendorScenes, setup: setupScenes, framing: framingScenes };
export const allScenes = Object.values(sceneGroups).flat();
const ids = new Set<string>();
for (const scene of allScenes) {
  if (ids.has(scene.id)) throw Error('Duplicate runtime evidence scene ID: ' + scene.id);
  ids.add(scene.id);
}
