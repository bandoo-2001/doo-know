import { scenePng, sceneSvg } from '../../../apps/web/whiteboards/canvas';
import { emptyWhiteboard } from '../../../shared/whiteboard';
declare global {
  interface Window {
    pngPrivacy: () => Promise<{ png: number[]; svg: string; unchanged: boolean }>;
  }
}
window.pngPrivacy = async () => {
  const scene = {
    ...emptyWhiteboard(),
    appState: { viewBackgroundColor: '#fff', exportEmbedScene: true },
    elements: [
      {
        id: 'private',
        type: 'text',
        text: 'PRIVATE_NATIVE_SCENE',
        x: 0,
        y: 0,
        width: 150,
        height: 40,
        fontSize: 20,
        fontFamily: 1,
        textAlign: 'left',
        verticalAlign: 'top',
        opacity: 0,
        isDeleted: false,
      },
    ],
  };
  const before = JSON.stringify(scene);
  const png = await scenePng(scene as any),
    svg = await sceneSvg(scene as any);
  return {
    png: Array.from(new Uint8Array(await png.arrayBuffer())),
    svg,
    unchanged: JSON.stringify(scene) === before,
  };
};
