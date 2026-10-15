import { defineComponent, h, ref, onMounted, onUnmounted } from 'vue';
import { NButton, NAlert, type PluginUIApi } from '@dooknow/plugin-ui';
export function activate(api: PluginUIApi) {
  const Settings = defineComponent({ setup() {
    const status = ref<any>(), rows = ref<any[]>([]), error = ref(''), cursor = ref<string>();
    async function load() { try { status.value = await api.call('provider','mcp.status',{}); const logs = await api.call('provider','mcp.calls',{}); rows.value=logs.items; cursor.value=logs.nextCursor; error.value=''; } catch(e) { error.value=(e as Error).message; } }
    async function more() { const logs = await api.call('provider','mcp.calls',{cursor:cursor.value}); rows.value.push(...logs.items); cursor.value=logs.nextCursor; }
    async function revoke(clientId: string) { try { const result = await api.call('command','mcp.revoke',{clientId}); api.notify(result.cleanupPending ? '授权已撤销；令牌存储清理待重试' : '授权已撤销'); await load(); } catch(e) { error.value=(e as Error).message; } }
    let timer: ReturnType<typeof setInterval>; onMounted(() => { void load(); timer=setInterval(load,10000); }); onUnmounted(() => clearInterval(timer));
    return () => h('div',{class:'dooknow-mcp-settings'},[
      h('h3','连接与授权'), error.value && h(NAlert,{type:'error'},()=>error.value),
      status.value && h('div',[
        h('p',status.value.connection.oauth.ready ? 'OAuth 可连接：'+status.value.connection.oauth.address : 'OAuth 尚未就绪：'+status.value.connection.oauth.reason),
        status.value.connection.tunnel && h('p','Tunnel：'+(status.value.connection.tunnel.ready ? status.value.connection.tunnel.address : status.value.connection.tunnel.reason)),
        h('p','授权客户端'), ...status.value.clients.map((c:any)=>h('div',{key:c.id},[h('span',c.clientId+' · '+(c.active?'已授权':'已撤销')+' · '+c.scopes.join('、')), c.active && h(NButton,{onClick:()=>revoke(c.clientId)},()=> '撤销')]))
      ]), h('h3','最近调用'), h('p','仅保留工具名、客户端、耗时和结果；不记录查询或正文。'),
      ...rows.value.map(r=>h('p',{key:r.id},`${r.at} · ${r.tool} · ${r.client} · ${r.elapsedMs}ms · ${r.code}`)),
      cursor.value && h(NButton,{onClick:more},()=> '加载更早调用'), h(NButton,{onClick:load},()=> '刷新连接与调用')
    ]);
  } });
  const dispose = api.registerComponent('mcp.settings',Settings);
  const nav = api.registerComponent('mcp.navigation',defineComponent({setup:()=>()=>h(NButton,{onClick:()=>api.openPanel('mcp.settings')},()=> 'MCP 连接')}));
  return () => { dispose(); nav(); };
}
