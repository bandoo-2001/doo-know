import { defineComponent, h, ref, onMounted, onUnmounted } from 'vue';
import { NButton, NAlert, type PluginUIApi } from '@dooknow/plugin-ui';

const styles = `
.dooknow-mcp-settings { min-width: 0; color: var(--text, #262b36); font-size: 13px; line-height: 1.6; }
.dooknow-mcp-settings * { box-sizing: border-box; }
.dooknow-mcp-settings h3 { margin: 0; font-size: 15px; font-weight: 600; }
.dooknow-mcp-settings p { margin: 0; overflow-wrap: anywhere; }
.dooknow-mcp-settings .mcp-section + .mcp-section { margin-top: 24px; }
.dooknow-mcp-settings .mcp-heading { margin-bottom: 12px; }
.dooknow-mcp-settings .mcp-description { margin-top: 5px; color: var(--muted, #7a8190); font-size: 12px; }
.dooknow-mcp-settings .mcp-connections { display: grid; gap: 8px; margin: 12px 0 18px; }
.dooknow-mcp-settings .mcp-connection { position: relative; padding: 11px 13px 11px 28px; border: 1px solid var(--border, #e3e6ec); border-radius: 6px; background: var(--surface-soft, #fafbfc); }
.dooknow-mcp-settings .mcp-connection::before { position: absolute; top: 19px; left: 13px; width: 6px; height: 6px; border-radius: 50%; content: ''; background: #b7bdc7; }
.dooknow-mcp-settings .mcp-connection.ready::before { background: var(--blue, #4566c6); }
.dooknow-mcp-settings .mcp-label { margin-bottom: 8px; font-size: 12px; font-weight: 600; color: var(--muted, #7a8190); }
.dooknow-mcp-settings .mcp-list { display: grid; gap: 8px; }
.dooknow-mcp-settings .mcp-client { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px 13px; border: 1px solid var(--border, #e3e6ec); border-radius: 6px; }
.dooknow-mcp-settings .mcp-client-info { min-width: 0; }
.dooknow-mcp-settings .mcp-client-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px 8px; overflow-wrap: anywhere; }
.dooknow-mcp-settings .mcp-client-id { font-weight: 500; }
.dooknow-mcp-settings .mcp-state { flex-shrink: 0; padding: 0 6px; border-radius: 4px; background: var(--surface, #f5f6f8); font-size: 11px; color: var(--muted, #7a8190); }
.dooknow-mcp-settings .mcp-state.active { color: var(--blue, #4566c6); }
.dooknow-mcp-settings .mcp-scopes { margin-top: 5px; color: var(--muted, #7a8190); font-size: 12px; }
.dooknow-mcp-settings .mcp-client > .n-button { flex-shrink: 0; }
.dooknow-mcp-settings .mcp-call { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 14px; padding: 11px 13px; border: 1px solid var(--border, #e3e6ec); border-radius: 6px; }
.dooknow-mcp-settings .mcp-call-tool { min-width: 0; overflow-wrap: anywhere; font-weight: 500; }
.dooknow-mcp-settings .mcp-call-code { align-self: start; padding: 0 6px; border-radius: 4px; background: var(--surface, #f5f6f8); color: var(--muted, #7a8190); font: 11px/1.8 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.dooknow-mcp-settings .mcp-call-meta { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 2px 12px; color: var(--muted, #7a8190); font-size: 11px; font-variant-numeric: tabular-nums; }
.dooknow-mcp-settings .mcp-call-meta span { min-width: 0; overflow-wrap: anywhere; }
.dooknow-mcp-settings .mcp-empty { padding: 18px 13px; border: 1px dashed var(--border, #e3e6ec); border-radius: 6px; background: var(--surface-soft, #fafbfc); color: var(--muted, #7a8190); font-size: 12px; }
.dooknow-mcp-settings .mcp-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.dooknow-mcp-settings > .n-alert { margin-bottom: 14px; }
@media (max-width: 600px) {
  .dooknow-mcp-settings .mcp-client { gap: 8px; padding: 11px; }
  .dooknow-mcp-settings .mcp-call { padding: 11px; }
  .dooknow-mcp-settings .mcp-call-code { max-width: 110px; }
}
`;

export function activate(api: PluginUIApi) {
  const Settings = defineComponent({
    setup() {
      const status = ref<any>(),
        rows = ref<any[]>([]),
        error = ref(''),
        cursor = ref<string>();
      async function load() {
        try {
          status.value = await api.call('provider', 'mcp.status', {});
          const logs = await api.call('provider', 'mcp.calls', {});
          rows.value = logs.items;
          cursor.value = logs.nextCursor;
          error.value = '';
        } catch (e) {
          error.value = (e as Error).message;
        }
      }
      async function more() {
        const logs = await api.call('provider', 'mcp.calls', { cursor: cursor.value });
        rows.value.push(...logs.items);
        cursor.value = logs.nextCursor;
      }
      async function revoke(clientId: string) {
        try {
          const result = await api.call('command', 'mcp.revoke', { clientId });
          api.notify(result.cleanupPending ? '授权已撤销；令牌存储清理待重试' : '授权已撤销');
          await load();
        } catch (e) {
          error.value = (e as Error).message;
        }
      }
      let timer: ReturnType<typeof setInterval>;
      onMounted(() => {
        void load();
        timer = setInterval(load, 10000);
      });
      onUnmounted(() => clearInterval(timer));
      return () =>
        h('div', { class: 'dooknow-mcp-settings' }, [
          h('style', styles),
          error.value && h(NAlert, { type: 'error' }, () => error.value),
          h('section', { class: 'mcp-section' }, [
            h('h3', '连接与授权'),
            status.value
              ? h('div', [
                  h('div', { class: 'mcp-connections' }, [
                    h(
                      'p',
                      { class: ['mcp-connection', { ready: status.value.connection.oauth.ready }] },
                      status.value.connection.oauth.ready
                        ? 'OAuth 可连接：' + status.value.connection.oauth.address
                        : 'OAuth 尚未就绪：' + status.value.connection.oauth.reason,
                    ),
                    status.value.connection.tunnel &&
                      h(
                        'p',
                        {
                          class: [
                            'mcp-connection',
                            { ready: status.value.connection.tunnel.ready },
                          ],
                        },
                        'Tunnel：' +
                          (status.value.connection.tunnel.ready
                            ? status.value.connection.tunnel.address
                            : status.value.connection.tunnel.reason),
                      ),
                  ]),
                  h('p', { class: 'mcp-label' }, '授权客户端'),
                  h(
                    'div',
                    { class: 'mcp-list' },
                    status.value.clients.length
                      ? status.value.clients.map((c: any) =>
                          h('div', { key: c.id, class: 'mcp-client' }, [
                            h('div', { class: 'mcp-client-info' }, [
                              h('div', { class: 'mcp-client-heading' }, [
                                h('span', { class: 'mcp-client-id' }, c.clientId),
                                h(
                                  'span',
                                  { class: ['mcp-state', { active: c.active }] },
                                  c.active ? '已授权' : '已撤销',
                                ),
                              ]),
                              h('p', { class: 'mcp-scopes' }, c.scopes.join(' · ')),
                            ]),
                            c.active &&
                              h(
                                NButton,
                                { size: 'small', onClick: () => revoke(c.clientId) },
                                () => '撤销',
                              ),
                          ]),
                        )
                      : [
                          h(
                            'p',
                            { class: 'mcp-empty' },
                            '暂无授权客户端。连接后可在这里管理访问权限。',
                          ),
                        ],
                  ),
                ])
              : !error.value && h('p', { class: 'mcp-empty' }, '正在读取连接状态…'),
          ]),
          h('section', { class: 'mcp-section' }, [
            h('div', { class: 'mcp-heading' }, [
              h('h3', '最近调用'),
              h(
                'p',
                { class: 'mcp-description' },
                '仅保留工具名、客户端、耗时和结果；不记录查询或正文。',
              ),
            ]),
            h(
              'div',
              { class: 'mcp-list' },
              rows.value.length
                ? rows.value.map((r) =>
                    h('div', { key: r.id, class: 'mcp-call' }, [
                      h('span', { class: 'mcp-call-tool' }, r.tool),
                      h('span', { class: 'mcp-call-code' }, r.code),
                      h('div', { class: 'mcp-call-meta' }, [
                        h('span', r.at),
                        h('span', r.client),
                        h('span', `${r.elapsedMs} ms`),
                      ]),
                    ]),
                  )
                : [h('p', { class: 'mcp-empty' }, '暂无调用记录。')],
            ),
          ]),
          h('div', { class: 'mcp-actions' }, [
            cursor.value && h(NButton, { size: 'small', onClick: more }, () => '加载更早调用'),
            h(NButton, { size: 'small', onClick: load }, () => '刷新连接与调用'),
          ]),
        ]);
    },
  });
  const dispose = api.registerComponent('mcp.settings', Settings);
  const nav = api.registerComponent(
    'mcp.navigation',
    defineComponent({
      setup: () => () =>
        h(NButton, { onClick: () => api.openPanel('mcp.settings') }, () => 'MCP 连接'),
    }),
  );
  return () => {
    dispose();
    nav();
  };
}
