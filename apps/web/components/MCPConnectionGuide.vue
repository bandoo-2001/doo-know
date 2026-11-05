<script setup lang="ts">
import Icon from './Icon.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import type { PluginView } from '../../../packages/plugin-contracts';
import type { MCPConnectionState } from '../../../shared/mcp-connection-contracts';
import { api } from '../api';
import MCPClientPermissions from './MCPClientPermissions.vue';
import MCPApiClients from './MCPApiClients.vue';
const props = defineProps<{ plugin: PluginView; mode?: string; dirty: boolean }>();
const state = ref<MCPConnectionState>();
const busy = ref(false),
  error = ref(''),
  actionError = ref(''),
  notice = ref(''),
  revokeClient = ref('');
const path = ref(props.plugin.config.oauthEnabled === false ? 'api-key' : 'oauth');
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
async function load() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    state.value = await api<MCPConnectionState>('/api/platform/mcp/connection');
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
    error.value = '暂时无法读取连接状态。教程仍可查看，请检查连接后重试。';
  } finally {
    busy.value = false;
  }
}
async function copy(value: string, label: string) {
  notice.value = '';
  try {
    await navigator.clipboard.writeText(value);
    notice.value = label + '已复制';
  } catch {
    notice.value = '无法自动复制，请选中下方内容手动复制。';
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
watch(() => [props.plugin.state, props.plugin.configVersion], load);
</script>
<template>
  <section class="mcp-guide" aria-label="MCP 连接指南">
    <div class="guide-heading">
      <div>
        <h3 class="settings-section-title"><Icon name="link" :size="18" />MCP 连接</h3>
        <p>通过 OAuth 或独立 API Key，将支持 MCP 的客户端连接到你授权的业务与资源。</p>
      </div>
      <AButton size="small" :loading="busy" @click="load">检查本机连接条件</AButton>
    </div>
    <AAlert v-if="error" type="warning" show-icon :message="error" />
    <AAlert v-if="actionError" type="error" show-icon :message="actionError" />
    <AAlert
      v-if="dirty"
      type="info"
      show-icon
      message="你有未保存的配置。下方状态和地址依据已保存配置，请先保存再签发或更新授权。"
    />
    <ul class="connection-progress" aria-label="连接进度">
      <li>
        <strong>1. 配置</strong
        ><span>{{
          dirty
            ? '配置尚未保存'
            : plugin.state === 'enabled'
              ? '配置已保存，插件已启用'
              : '配置已保存，插件尚未启用'
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
          !error && state?.latestSuccessfulCall ? '已有工具成功调用记录' : '尚未确认工具调用'
        }}</span>
      </li>
    </ul>
    <p class="guide-muted">本机状态不能验证外部网络可达性。历史调用不代表客户端当前在线。</p>
    <p v-if="!error && state?.latestConnectionAttempt" class="guide-muted">
      最近一次连接请求：{{ state.latestConnectionAttempt.mode === 'oauth' ? 'OAuth' : 'API Key' }} ·
      {{
        state.latestConnectionAttempt.outcome === 'authenticated'
          ? '已通过身份校验，尚需核对工具执行'
          : '被拒绝，请核对插件状态、连接方式和授权'
      }}（{{ state.latestConnectionAttempt.code }}）。
    </p>
    <div class="guide-paths" role="group" aria-label="选择认证方式">
      <AButton
        :type="path === 'oauth' ? 'primary' : 'default'"
        :aria-pressed="path === 'oauth'"
        @click="path = 'oauth'"
        >OAuth 接入</AButton
      ><AButton
        :type="path === 'api-key' ? 'primary' : 'default'"
        :aria-pressed="path === 'api-key'"
        @click="path = 'api-key'"
        >API Key 接入</AButton
      >
    </div>
    <template v-if="path === 'oauth'">
      <p>
        在支持 OAuth 的 MCP 客户端填写下方服务地址，发起连接后登录
        DooKnow，核对业务、资源范围和权限再同意授权。
      </p>
      <AAlert
        v-if="origin && !publicOrigin"
        type="warning"
        message="OAuth 需要客户端和授权浏览器可达的 HTTPS 站点。"
        description="请管理员配置域名、TLS、反向代理与部署访问来源 APP_ORIGIN，再检查授权地址。"
      />
      <p v-if="plugin.config.oauthEnabled === false">OAuth 已在保存的配置中停用。</p>
    </template>
    <template v-else>
      <p>
        为每个应用创建独立客户端，设置资源权限和密钥有效期。客户端需要支持 Streamable HTTP 和自定义
        Authorization 请求头。
      </p>
      <p>
        认证头：<code>Authorization: Bearer &lt;API Key&gt;</code>。密钥只用于下方 API Key
        地址，请保存在客户端的安全凭据设置中。
      </p>
      <p v-if="plugin.config.apiKeyEnabled === false">API Key 接入已在保存的配置中停用。</p>
    </template>
    <div v-if="endpoint" class="guide-value">
      <span>{{ path === 'oauth' ? 'OAuth MCP 服务地址' : 'API Key MCP 服务地址' }}</span
      ><code>{{ endpoint }}</code
      ><AButton size="small" :disabled="dirty" @click="copy(endpoint, '连接地址')"
        >复制连接地址</AButton
      >
    </div>
    <p class="guide-muted">
      两个地址使用同一个 DooKnow
      服务。远程访问所需的域名、TLS、反向代理和网络连通由外部基础设施提供。请勿把密钥放进 URL
      或聊天消息。
    </p>
    <details class="guide-troubleshooting">
      <summary>连接与验证步骤</summary>
      <ol class="guide-steps">
        <li>保存插件权限和认证开关，并启用 MCP 插件。</li>
        <li>
          在客户端选择认证方式与对应地址。OAuth 按网页提示授权；API Key
          复制新签发密钥到客户端认证设置。
        </li>
        <li>完成工具发现，再发起一次读取，核对真实业务结果与下方成功调用记录。</li>
        <li>
          调用被拒绝时，检查密钥是否到期、授权是否撤销、插件是否启用，以及当前资源和权限范围。
        </li>
      </ol>
    </details>
    <p v-if="!error && state?.latestSuccessfulCall" class="guide-call">
      最近工具调用：{{ state.latestSuccessfulCall.tool }} ·
      {{ new Date(state.latestSuccessfulCall.at).toLocaleString() }}。
    </p>
    <MCPApiClients
      :disabled="dirty || plugin.state !== 'enabled' || plugin.config.apiKeyEnabled === false"
    />
    <section v-if="state?.clients.length" class="guide-clients" aria-label="连接授权管理">
      <h4>OAuth 连接授权</h4>
      <p class="guide-muted">
        停用插件会暂停访问，保留授权；重新启用后授权可能继续使用。撤销后需重新授权。
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
          ><template #icon><Icon class="settings-button-icon" name="close" :size="15" /></template
          >撤销此连接授权</AButton
        >
        <div v-if="revokeClient === client.clientId" class="guide-paths">
          <span>此客户端将无法继续使用原授权。</span
          ><AButton size="small" danger :loading="busy" @click="revoke"
            ><template #icon><Icon class="settings-button-icon" name="close" :size="15" /></template
            >确认撤销授权</AButton
          ><AButton size="small" :disabled="busy" @click="revokeClient = ''">取消</AButton>
        </div>
      </div>
    </section>
    <p v-if="notice" role="status" class="guide-notice">{{ notice }}</p>
  </section>
</template>
<style scoped>
.mcp-guide {
  padding: 18px;
  margin-bottom: 24px;
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
  background: var(--surface-soft);
  min-width: 0;
  font-size: 13px;
  line-height: 1.75;
}
.guide-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}
.mcp-guide h3,
.mcp-guide h4 {
  margin: 0 0 6px;
  font-weight: 600;
}
.mcp-guide h3 {
  font-size: 15px;
}
.mcp-guide h4 {
  font-size: 14px;
}
.mcp-guide p {
  margin: 6px 0;
  overflow-wrap: anywhere;
}
.mcp-guide a {
  color: var(--blue);
  text-decoration: underline;
  text-underline-offset: 3px;
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
.guide-muted,
.guide-sources {
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
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 12px;
  margin: 12px 0;
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
}
.guide-value > span {
  width: 100%;
  font-weight: 500;
}
.guide-value code {
  flex: 1 1 200px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.mcp-guide pre {
  max-width: 100%;
  overflow-x: auto;
  padding: 12px;
  border-radius: var(--ui-radius, 8px);
  background: var(--surface);
  font-size: 12px;
  line-height: 1.7;
}
.mcp-guide summary {
  cursor: pointer;
  color: var(--blue);
}
.guide-clients {
  margin-top: 20px;
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
.guide-sources {
  padding-top: 14px;
  margin-top: 16px !important;
  border-top: 1px solid var(--border);
}
@media (max-width: 600px) {
  .mcp-guide {
    padding: 13px;
  }
  .guide-heading {
    flex-direction: column;
  }
  .connection-progress {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
