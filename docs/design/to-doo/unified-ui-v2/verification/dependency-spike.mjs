import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
const native = `import { ref, onMounted, onActivated, onDeactivated, onUnmounted } from 'vue';
export function useFocusLifecycle(tick,poll,wake){
 const narrow=ref(false);let clock,refresh,active=false;
 function resize(){narrow.value=window.innerWidth<=600}
 function activate(){if(active)return;active=true;resize();clock=setInterval(tick,1000);refresh=setInterval(poll,15000);window.addEventListener('resize',resize);document.addEventListener('visibilitychange',wake)}
 function deactivate(){active=false;clearInterval(clock);clearInterval(refresh);window.removeEventListener('resize',resize);document.removeEventListener('visibilitychange',wake)}
 onMounted(activate);onActivated(activate);onDeactivated(deactivate);onUnmounted(deactivate);return {narrow};
}`;
const vueuse = `import {ref,onMounted,onActivated,onDeactivated} from 'vue';
import {useIntervalFn,useMediaQuery,useEventListener} from '@vueuse/core';
export function useFocusLifecycle(tick,poll,wake){
 const active=ref(false),narrow=useMediaQuery('(max-width:600px)');
 const clock=useIntervalFn(tick,1000,{immediate:false}),refresh=useIntervalFn(poll,15000,{immediate:false});
 useEventListener(()=>active.value?document:undefined,'visibilitychange',wake);
 function activate(){active.value=true;clock.resume();refresh.resume()}
 function deactivate(){active.value=false;clock.pause();refresh.pause()}
 onMounted(activate);onActivated(activate);onDeactivated(deactivate);return {narrow};
}`;
const projectRoot = new URL('../../../../../', import.meta.url).pathname;
const results = [];
for (const [name, source] of Object.entries({ native, vueuse })) {
  const result = await build({
    stdin: { contents: source, resolveDir: projectRoot, sourcefile: name + '.js' },
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    external: ['vue'],
    write: false,
    metafile: true,
  });
  const content = result.outputFiles[0].contents;
  results.push({
    name,
    sourceBytes: Buffer.byteLength(source),
    bundleBytes: content.length,
    gzipBytes: gzipSync(content).length,
    inputs: Object.keys(result.metafile.inputs).length,
  });
}
await writeFile(
  new URL('./dependency-spike.json', import.meta.url),
  JSON.stringify(
    { vue: '3.5.44', vueuse: '15.0.0', external: ['vue'], target: 'es2022', results },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify(results));
