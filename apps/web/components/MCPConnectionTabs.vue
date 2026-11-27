<script setup lang="ts">
import { copyText } from '../copy-text';
import Icon from './Icon.vue';
import { computed, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import type { FeatureView } from '../../../shared/feature-contracts';
import type { MCPConnectionState } from '../../../shared/mcp-connection-contracts';
import { api } from '../api';
import MCPClientPermissions from './MCPClientPermissions.vue';
import MCPApiClients from './MCPApiClients.vue';
import MCPActivity from './MCPActivity.vue';
const props = defineProps<{ feature: FeatureView; dirty: boolean }>();
const tabs = [
  { key: 'guide', label: '接入指南' },
  { key: 'clients', label: '客户端' },
  { key: 'permissions', label: '权限设置' },
  { key: 'activity', label: '调用记录' },
] as const;
type Tab = (typeof tabs)[number]['key'];
const activeTab = ref<Tab>(props.dirty ? 'permissions' : 'guide');
const visited = reactive(new Set<Tab>([activeTab.value]));
const id = useId();
function selectTab(tab: Tab) {
  visited.add(tab);
  activeTab.value = tab;
  document.getElementById(id + '-tab-' + tab)?.focus();
}
function navigateTabs(event: KeyboardEvent, index: number) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  let next: number;
  switch (event.key) {
    case 'ArrowRight':
      next = (index + 1) % tabs.length;
      break;
    case 'ArrowLeft':
      next = (index + tabs.length - 1) % tabs.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = tabs.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  selectTab(tabs[next].key);
}
const state = ref<MCPConnectionState>();
const busy = ref(false),
  error = ref(''),
  actionError = ref(''),
  copyNotice = ref(''),
  notice = ref(''),
  revokeClient = ref('');
const path = ref(props.feature.config.oauthEnabled === false ? 'api-key' : 'oauth');
const origin = computed(() => state.value?.origin || '');
const publicOrigin = computed(() => origin.value.startsWith('https://'));
const endpoint = computed(() =>
  path.value === 'api-key'
    ? state.value?.connection.apiKey.address || ''
    : state.value?.connection.oauth.address || '',
);
const localReady = computed(
  () =>
    !error.value &&
    (path.value === 'api-key'
      ? state.value?.connection.apiKey.ready
      : state.value?.connection.oauth.ready),
);
function scopes(values: string[]) {
  const labels: Record<string, string> = {
    'knowledge:read': '读取资料',
    'knowledge:write': '修改资料',
    'knowledge:index': '维护索引',
    'knowledge:organize': '自主整理',
    'knowledge:archive': '归档资料',
    'knowledge:share': '管理资料分享',
    'knowledge:manage': '维护资料设置',
    'blog:read': '查看博客',
    'blog:write': '编辑博客草稿',
    'blog:manage': '管理博客设置和文章',
    'blog:publish': '公开发布博客',
    'to-doo:read': '读取 To Doo',
    'to-doo:write': '修改 To Doo',
    'to-doo:share': '导出和分享 To Doo',
    'to-doo:integrations': '管理日历与提醒设备',
  };
  return values.map((value) => labels[value] || value).join('、') || '当前不可访问';
}
let loadVersion = 0;
onBeforeUnmount(() => {
  loadVersion++;
});
async function load() {
  const version = ++loadVersion;
  busy.value = true;
  error.value = '';
  try {
    const connection = await api<MCPConnectionState>('/api/platform/mcp/connection');
    if (version !== loadVersion) return;
    state.value = connection;
    if (
      actionError.value &&
      revokeClient.value &&
      state.value.clients.some((client) => client.clientId === revokeClient.value && !client.active)
    ) {
      revokeClient.value = '';
      actionError.value = '';
      notice.value = '已核对：连接授权已撤销。';
    }
  } catch {
    if (version === loadVersion) error.value = '暂时无法读取连接状态，请刷新重试。';
  } finally {
    if (version === loadVersion) busy.value = false;
  }
}
async function copy(value: string, label: string) {
  copyNotice.value = '';
  try {
    await copyText(value);
    copyNotice.value = label + '已复制';
  } catch {
    copyNotice.value = '无法自动复制，请选中下方内容手动复制。';
  }
}
async function revoke() {
  const clientId = revokeClient.value;
  busy.value = true;
  actionError.value = '';
  try {
    const result = await api('/api/platform/mcp/clients/revoke', 'POST', { clientId });
    if (state.value)
      state.value = {
        ...state.value,
        clients: state.value.clients.map((client) =>
          client.clientId === clientId
            ? { ...client, active: false, effectiveScopes: [], effectivePrefixes: [] }
            : client,
        ),
      };
    revokeClient.value = '';
    notice.value = result.cleanupPending
      ? '授权已撤销，令牌清理待重试。'
      : '授权已撤销；再次连接需要重新授权。';
  } catch {
    actionError.value = '撤销未完成，请刷新状态后核对并重试。';
  } finally {
    busy.value = false;
  }
  await load();
}
onMounted(load);
watch(() => [props.feature.state, props.feature.configVersion], load);
</script>
<template>
  <div class="mcp-tabs">
    <div class="mcp-tab-bar" role="tablist" aria-label="MCP 连接选项">
      <button
        v-for="(tab, index) in tabs"
        :key="tab.key"
        type="button"
        role="tab"
        :id="id + '-tab-' + tab.key"
        :aria-controls="id + '-panel-' + tab.key"
        :aria-selected="activeTab === tab.key"
        :tabindex="activeTab === tab.key ? 0 : -1"
        @click="selectTab(tab.key)"
        @keydown="navigateTabs($event, index)"
      >
        {{ tab.label }}
      </button>
    </div>
    <section
      v-for="tab in tabs"
      :key="tab.key"
      v-show="activeTab === tab.key"
      :id="id + '-panel-' + tab.key"
      :aria-labelledby="id + '-tab-' + tab.key"
      role="tabpanel"
      tabindex="0"
      class="settings-card mcp-tab-panel"
    >
      <template v-if="visited.has(tab.key)">
        <div
          v-if="tab.key === 'guide' || tab.key === 'clients'"
          class="mcp-guide"
          role="region"
          :aria-label="tab.key === 'guide' ? 'MCP 连接指南' : 'MCP 客户端管理'"
        >
          <div class="guide-heading">
            <h2 class="settings-section-title">
              {{ tab.key === 'guide' ? '连接客户端' : '客户端授权' }}
            </h2>
            <AButton
              v-if="tab.key === 'guide' || path === 'oauth'"
              size="small"
              :loading="busy"
              @click="load"
            >
              {{ tab.key === 'guide' ? '检查本机连接条件' : '刷新 OAuth 授权' }}
            </AButton>
          </div>
          <AAlert
            v-if="error && (tab.key === 'guide' || path === 'oauth')"
            type="warning"
            show-icon
            :message="error"
          />
          <AAlert v-if="dirty" type="info" show-icon message="权限设置有未保存的更改。">
            <template #action
              ><AButton size="small" @click="selectTab('permissions')">前往保存</AButton></template
            >
          </AAlert>
          <div
            class="guide-paths"
            role="group"
            :aria-label="tab.key === 'guide' ? '选择认证方式' : '客户端类型'"
          >
            <AButton
              :type="path === 'oauth' ? 'primary' : 'default'"
              :aria-pressed="path === 'oauth'"
              @click="path = 'oauth'"
            >
              {{ tab.key === 'guide' ? 'OAuth 接入' : 'OAuth 授权' }}
            </AButton>
            <AButton
              :type="path === 'api-key' ? 'primary' : 'default'"
              :aria-pressed="path === 'api-key'"
              @click="path = 'api-key'"
            >
              {{ tab.key === 'guide' ? 'API Key 接入' : 'API Key 客户端' }}
            </AButton>
          </div>
          <template v-if="tab.key === 'guide'">
            <div v-if="endpoint" class="guide-value">
              <span>{{ path === 'oauth' ? 'OAuth MCP 服务地址' : 'API Key MCP 服务地址' }}</span
              ><code>{{ endpoint }}</code
              ><AButton size="small" @click="copy(endpoint, '连接地址')">复制连接地址</AButton>
            </div>
            <template v-if="path === 'oauth'">
              <p>将服务地址填入客户端，连接后登录 DooKnow 并确认授权。</p>
              <AAlert
                v-if="origin && !publicOrigin"
                type="warning"
                message="OAuth 需要客户端和授权浏览器可达的 HTTPS 站点。"
              />
              <p v-if="feature.config.oauthEnabled === false">OAuth 已在保存的配置中停用。</p>
            </template>
            <template v-else>
              <p>在客户端选择 Streamable HTTP，填入服务地址和认证头。</p>
              <p>
                认证头：<code>Authorization: Bearer &lt;API Key&gt;</code
                >。请将密钥保存在客户端的凭据设置中。
              </p>
              <p v-if="feature.config.apiKeyEnabled === false">
                API Key 接入已在保存的配置中停用。
              </p>
            </template>
            <details class="guide-troubleshooting">
              <summary>连接与验证步骤</summary>
              <p v-if="path === 'oauth' && origin && !publicOrigin" class="guide-muted">
                请管理员配置 HTTPS 域名、反向代理和部署访问来源 APP_ORIGIN，再检查授权地址。
              </p>
              <ul class="connection-progress" aria-label="连接进度">
                <li>
                  <strong>1. 配置</strong
                  ><span>{{
                    dirty
                      ? '配置尚未保存'
                      : feature.state === 'enabled'
                        ? '配置已保存，MCP 已启用'
                        : '配置已保存，MCP 尚未启用'
                  }}</span>
                </li>
                <li>
                  <strong>2. 本机服务</strong
                  ><span>{{
                    busy
                      ? '正在检查…'
                      : error
                        ? '暂未获取状态'
                        : localReady
                          ? '本机连接条件已满足'
                          : '需要完成下方准备'
                  }}</span>
                </li>
                <li><strong>3. 网络可达</strong><span>外部连接尚未验证</span></li>
                <li>
                  <strong>4. 工具调用</strong
                  ><span>{{
                    !error && state?.latestSuccessfulCall
                      ? '已有工具成功调用记录'
                      : '尚未确认工具调用'
                  }}</span>
                </li>
              </ul>
              <p class="guide-muted">
                本机状态不能验证外部网络可达性。历史调用不代表客户端当前在线。
              </p>
              <p v-if="!error && state?.latestConnectionAttempt" class="guide-muted">
                最近一次连接请求：{{
                  state.latestConnectionAttempt.mode === 'oauth' ? 'OAuth' : 'API Key'
                }}
                ·
                {{
                  state.latestConnectionAttempt.outcome === 'authenticated'
                    ? '已通过身份校验，尚需核对工具执行'
                    : '被拒绝，请核对 MCP 服务状态、连接方式和授权'
                }}（{{ state.latestConnectionAttempt.code }}）。
              </p>
              <ol class="guide-steps">
                <li>保存权限和认证设置，再启用 MCP 服务。</li>
                <li>
                  在客户端选择认证方式与对应地址。OAuth 按网页提示授权；API Key
                  复制新签发密钥到客户端认证设置。
                </li>
                <li>在客户端发起一次读取，然后到“调用记录”核对工具名和结果。</li>
                <li>
                  调用被拒绝时，检查密钥是否到期、授权是否撤销、MCP
                  服务是否启用，以及当前资源和权限范围。
                </li>
              </ol>
            </details>
            <p v-if="!error && state?.latestSuccessfulCall" class="guide-call">
              最近工具调用：{{ state.latestSuccessfulCall.tool }} ·
              {{ new Date(state.latestSuccessfulCall.at).toLocaleString() }}。
            </p>

            <p v-if="copyNotice" role="status" class="guide-notice">{{ copyNotice }}</p>
            <AButton type="link" class="manage-clients" @click="selectTab('clients')">
              {{ path === 'oauth' ? '管理 OAuth 授权' : '管理 API Key' }}
            </AButton>
          </template>
          <template v-else>
            <KeepAlive>
              <MCPApiClients
                v-if="activeTab === 'clients' && path === 'api-key'"
                :disabled="
                  dirty || feature.state !== 'enabled' || feature.config.apiKeyEnabled === false
                "
              />
            </KeepAlive>
            <AAlert
              v-if="actionError && path === 'oauth'"
              type="error"
              show-icon
              :message="actionError"
            />
            <section
              v-show="path === 'oauth'"
              v-if="state"
              class="guide-clients"
              aria-label="连接授权管理"
            >
              <h4>OAuth 连接授权</h4>
              <p v-if="state.clients.length" class="guide-muted">
                关闭 MCP 服务会暂停访问，保留授权；重新启用后授权可能继续使用。撤销后需重新授权。
              </p>
              <p v-if="!state.clients.length && !error && !busy" role="status">
                暂无 OAuth 客户端授权。
              </p>
              <div v-for="client in state.clients" :key="client.clientId" class="guide-client">
                <strong>{{ client.clientId }}</strong
                ><span>{{ client.active ? '授权保留' : '已撤销' }}</span>
                <MCPClientPermissions :client="client" @updated="load" />
                <p v-if="!client.permissionPolicy">已授予：{{ scopes(client.scopes) }}</p>
                <p v-if="!client.effectivePolicy">
                  当前生效：{{ scopes(client.effectiveScopes) }}；目录：{{
                    client.effectivePrefixes.join('、') || '无'
                  }}
                </p>
                <AButton
                  v-if="client.active && revokeClient !== client.clientId"
                  size="small"
                  :disabled="busy"
                  @click="revokeClient = client.clientId"
                  ><template #icon
                    ><Icon class="settings-button-icon" name="close" :size="15" /></template
                  >撤销此连接授权</AButton
                >
                <div v-if="revokeClient === client.clientId" class="guide-paths">
                  <span>此客户端将无法继续使用原授权。</span
                  ><AButton size="small" danger :loading="busy" @click="revoke"
                    ><template #icon
                      ><Icon class="settings-button-icon" name="close" :size="15" /></template
                    >确认撤销授权</AButton
                  ><AButton size="small" :disabled="busy" @click="revokeClient = ''">取消</AButton>
                </div>
              </div>
            </section>

            <p v-if="notice && path === 'oauth'" role="status" class="guide-notice">{{ notice }}</p>
          </template>
        </div>
        <slot v-else-if="tab.key === 'permissions'" name="permissions" />
        <template v-else>
          <MCPActivity v-if="feature.state === 'enabled'" :active="activeTab === 'activity'" />
          <p v-else class="settings-muted" role="status">启用 MCP 服务后可查看调用记录。</p>
        </template>
      </template>
    </section>
  </div>
</template>
<style scoped>
.mcp-tabs {
  min-width: 0;
}
.mcp-tab-bar {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
.mcp-tab-bar button {
  min-width: 0;
  min-height: 44px;
  padding: 6px 14px;
  background: transparent;
  color: var(--muted);
  border: 0;
  border-bottom: 2px solid transparent;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.mcp-tab-bar button[aria-selected='true'] {
  color: var(--blue);
  border-bottom-color: currentColor;
  font-weight: 600;
}
.mcp-tab-bar button:hover {
  background: var(--surface-soft);
}
.mcp-tab-bar button:focus-visible,
.mcp-tab-panel:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.mcp-tab-panel {
  min-width: 0;
}
.mcp-guide {
  min-width: 0;
  font-size: 13px;
  line-height: 1.75;
}
.manage-clients {
  padding-inline-start: 0;
  margin-top: 10px;
}
.guide-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
}
.mcp-guide h4 {
  margin: 0 0 6px;
  font-weight: 600;
}
.mcp-guide h4 {
  font-size: 14px;
}
.mcp-guide p {
  margin: 6px 0;
  overflow-wrap: anywhere;
}
.mcp-guide :deep(.ant-alert) {
  margin-top: 12px;
}
.connection-progress {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 16px 0 8px;
}
.connection-progress li {
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
  min-width: 0;
  overflow-wrap: anywhere;
}
.guide-muted {
  color: var(--muted);
  font-size: 12px;
}
.guide-paths {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 14px 0 8px;
}
.guide-steps {
  margin: 18px 0;
  padding-left: 23px;
}
.guide-steps > li {
  padding-left: 4px;
  margin-top: 20px;
}
.guide-value {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 10px;
  padding: 12px;
  margin: 12px 0;
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
}
.guide-value > span {
  font-weight: 500;
}
.guide-value code {
  grid-column: 1 / -1;
  grid-row: 2;
  overflow-wrap: anywhere;
}
.guide-value .ant-btn {
  grid-column: 2;
  grid-row: 1;
}
.mcp-guide summary {
  cursor: pointer;
  color: var(--blue);
}
.guide-clients {
  margin-top: 12px;
}
.guide-client {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.guide-client > span {
  margin-left: 10px;
  color: var(--muted);
}
.guide-notice {
  color: var(--blue);
}
@media (max-width: 600px) {
  .mcp-tab-bar {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0;
  }
  .mcp-tab-bar button {
    padding-inline: 0;
    font-size: 13px;
  }
  .connection-progress {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
