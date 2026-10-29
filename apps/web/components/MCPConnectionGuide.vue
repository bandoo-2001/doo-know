<script setup lang="ts">
import Icon from './Icon.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import type { PluginView } from '../../../packages/plugin-contracts';
import type { MCPConnectionState } from '../../../shared/mcp-connection-contracts';
import { api } from '../api';
import MCPClientPermissions from './MCPClientPermissions.vue';
import MCPDomainPermissions from './MCPDomainPermissions.vue';
import type { PermissionPolicy } from '../../../shared/permissions';
const props = defineProps<{ plugin: PluginView; mode: string; dirty: boolean }>();
const state = ref<MCPConnectionState>();
const busy = ref(false),
  error = ref(''),
  actionError = ref(''),
  notice = ref(''),
  revokeClient = ref('');
const tunnelPolicy=ref<PermissionPolicy>(),tunnelCeiling=ref<PermissionPolicy>();
async function prepareTunnel(){
  if(busy.value || props.dirty)return;
  busy.value=true;actionError.value='';
  try{const current=await api<{policy:PermissionPolicy}>('/api/platform/mcp/permissions');tunnelCeiling.value=current.policy;tunnelPolicy.value=JSON.parse(JSON.stringify(current.policy));}
  catch{actionError.value='暂时无法读取当前权限，请刷新后重试。';}
  finally{busy.value=false;}
}
async function authorizeTunnel(){
  if(busy.value || props.dirty || !tunnelPolicy.value)return;
  busy.value=true;actionError.value='';
  try{await api('/api/platform/mcp/tunnel/authorize','POST',{permissionPolicy:tunnelPolicy.value});tunnelPolicy.value=undefined;notice.value='Tunnel 授权已更新，后续调用使用新权限。';}
  catch{actionError.value='未能确认 Tunnel 授权更新，请刷新连接状态后核对。';}
  finally{busy.value=false;}
  await load();
}
const guideExpanded = ref(false);
const path = ref(props.mode === 'tunnel' ? 'tunnel' : 'oauth');
watch(
  () => props.mode,
  (mode) => {
    path.value = mode === 'tunnel' ? 'tunnel' : 'oauth';
  },
);
const origin = computed(() => state.value?.origin || '');
const publicOrigin = computed(() => origin.value.startsWith('https://'));
const localAddress = computed(
  () => `http://127.0.0.1:${props.plugin.config.compatPort || 3071}/mcp`,
);
const endpoint = computed(() =>
  path.value === 'tunnel' ? localAddress.value : state.value?.connection.oauth.address || '',
);
const localReady = computed(
  () =>
    !error.value &&
    (path.value === 'tunnel'
      ? state.value?.connection.tunnel.ready
      : state.value?.connection.oauth.ready),
);
const installation = computed(
  () => `read -r -s -p 'OpenAI API key: ' CONTROL_PLANE_API_KEY; printf '\\n'
read -r -s -p 'DooKnow 连接密钥: ' DOOKNOW_MCP_TOKEN; printf '\\n'
export CONTROL_PLANE_API_KEY
export MCP_TUNNEL_AUTHORIZATION="Bearer \${DOOKNOW_MCP_TOKEN}"
unset DOOKNOW_MCP_TOKEN
read -r -p 'Tunnel ID: ' CONTROL_PLANE_TUNNEL_ID
export CONTROL_PLANE_TUNNEL_ID
tunnel-client run \\
  --control-plane.api-key env:CONTROL_PLANE_API_KEY \\
  --control-plane.tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \\
  --mcp.server-url url=${localAddress.value} \\
  --mcp.extra-headers 'Authorization: env:MCP_TUNNEL_AUTHORIZATION' \\
  --health.listen-addr 127.0.0.1:0`,
);
function scopes(values: string[]) {
  const labels: Record<string, string> = {
    'knowledge:read': '读取资料',
    'knowledge:write': '修改资料',
    'knowledge:index': '维护索引',
    'knowledge:organize': '自主整理',
    'knowledge:archive': '归档资料',
    'blog:read': '查看博客',
    'blog:publish': '公开发布博客',
    'to-doo:read': '读取 To Doo',
    'to-doo:write': '修改 To Doo',
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
  <section class="mcp-guide" aria-label="ChatGPT 连接指南">
    <div class="guide-heading">
      <div>
        <h3 class="settings-section-title">
          <Icon name="link" :size="18" />连接 ChatGPT：按步骤完成
        </h3>
        <p>让 ChatGPT 查找和读取你选择的笔记；允许修改后，也可创建和更新笔记。</p>
      </div>
      <AButton size="small" :loading="busy" @click="load"
        ><template #icon><Icon class="settings-button-icon" name="refresh" :size="15" /></template
        >检查本机连接条件</AButton
      >
    </div>
    <AAlert v-if="error" type="warning" show-icon :message="error" />
    <AAlert v-if="actionError" type="error" show-icon :message="actionError" />
    <AAlert
      v-if="dirty"
      type="info"
      show-icon
      message="你有未保存的配置。下方状态和复制的地址依据已保存配置，请先保存再启用。"
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
      <li><strong>3. 外部通道</strong><span>外部连接尚未验证</span></li>
      <li>
        <strong>4. 工具调用</strong
        ><span>{{
          !error && state?.latestSuccessfulCall ? '已有工具成功调用记录' : '尚未确认工具调用'
        }}</span>
      </li>
    </ul>
    <p class="guide-muted">
      本机检查不能验证公网可达性、隧道是否在线或 ChatGPT 的账号权限。历史调用也不代表通道当前在线。
    </p>
    <p v-if="!error && state?.latestConnectionAttempt" class="guide-muted">
      最近一次连接请求：{{
        state.latestConnectionAttempt.mode === 'oauth' ? '网页授权' : '本地隧道'
      }}
      ·
      {{
        state.latestConnectionAttempt.outcome === 'authenticated'
          ? '已通过身份校验，尚需核对工具执行'
          : '被拒绝，请核对插件状态、连接方式和授权'
      }}
      （{{ state.latestConnectionAttempt.code }}）。仅记录本次服务启动后的最近请求，不含密钥或正文。
    </p>
    <div class="guide-paths" role="group" aria-label="选择要查看的连接教程">
      <AButton
        :type="path === 'oauth' ? 'primary' : 'default'"
        :aria-pressed="path === 'oauth'"
        @click="
          path = 'oauth';
          guideExpanded = true;
        "
        ><template #icon><Icon class="settings-button-icon" name="help" :size="15" /></template
        >查看网页授权教程</AButton
      >
      <AButton
        :type="path === 'tunnel' ? 'primary' : 'default'"
        :aria-pressed="path === 'tunnel'"
        @click="
          path = 'tunnel';
          guideExpanded = true;
        "
        ><template #icon><Icon class="settings-button-icon" name="help" :size="15" /></template
        >查看本地隧道教程</AButton
      >
    </div>
    <p class="guide-muted">
      {{
        publicOrigin
          ? '当前部署使用 HTTPS，可先查看网页授权；仍需确认公网可达。'
          : '当前部署没有公网 HTTPS 地址。家庭或本地主机可查看本地隧道教程，或请管理员准备公网访问。'
      }}
    </p>
    <details
      :open="guideExpanded"
      @toggle="guideExpanded = ($event.target as HTMLDetailsElement).open"
    >
      <summary>开始配置：逐步查看教程</summary>
      <ol class="guide-steps">
        <li>
          <h4>确认账号与需要准备的工具</h4>
          <p>
            使用 ChatGPT 网页版，并确认账号或工作区允许添加自定义 MCP
            服务。找不到创建入口时，先向工作区管理员确认权限；账号套餐和界面入口可能不同。
          </p>
          <template v-if="path === 'oauth'">
            <p>
              本平台已经提供 MCP 服务与网页授权，无需另装旧版知识库 Bridge、Git 插件或
              Python。需要一个 ChatGPT 和授权浏览器都能访问的 HTTPS 站点。
            </p>
            <AAlert
              v-if="origin && !publicOrigin"
              type="warning"
              message="localhost 不能直接填到 ChatGPT 的公网连接地址中。"
              description="请管理员配置公开 HTTPS 站点、证书与转发，并把 DooKnow 的部署访问来源 APP_ORIGIN 设置为该站点，再重启验证。下面的“外部网页地址”只控制资料链接，不能代替部署配置。"
            />
          </template>
          <template v-else>
            <p>
              需要 OpenAI Platform 的隧道 ID、拥有隧道使用权限的运行用 API key，以及
              tunnel-client。它运行在 DooKnow 所在主机，不是浏览器插件；本页面无法检测它是否已安装。
            </p>
            <p>
              打开
              <a
                href="https://platform.openai.com/settings/organization/tunnels"
                target="_blank"
                rel="noopener noreferrer"
                >OpenAI 隧道设置</a
              >
              创建隧道，并关联实际使用的 ChatGPT 工作区。创建需要 Tunnels Read +
              Manage，运行和选择隧道需要 Read + Use；没有权限时联系组织管理员。
            </p>
            <p>
              从隧道设置中的下载入口安装与主机系统匹配的
              tunnel-client；已有工具时无需重复安装，在主机终端运行
              <code>tunnel-client help quickstart</code> 检查用法。OpenAI API key 与下方生成的
              DooKnow 连接密钥用途不同。
            </p>
          </template>
        </li>
        <li>
          <h4>在 DooKnow 保存权限并启用插件</h4>
          <p>
            在下方“连接方式”选择{{
              path === 'oauth' ? '网页授权（OAuth）' : '本地隧道（Tunnel）'
            }}。第一次连接建议保持只读，逐行填写允许访问的目录，然后点击“保存插件配置”和“启用插件”。
          </p>
          <p v-if="path === 'tunnel'">
            使用“生成连接密钥”准备 DooKnow
            密钥。请在保存前通过输入框的显示按钮复制并妥善保存，服务器不会回显已保存密钥。需要重新生成时，也要更新隧道客户端的对应值。
          </p>
          <p>
            关闭只读将允许客户端按授权创建、修改和归档笔记；“维护检索索引”是额外权限。博客公开发布还需开启“允许公开发布博客”，并在网页授权时单独勾选公开发布权限；隧道凭据按保存的配置授权。目录范围会和客户端授权取交集，权限变更后请重新检查访问结果。
          </p>
          <div v-if="endpoint" class="guide-value">
            <span>{{
              path === 'oauth' ? 'ChatGPT 的 MCP 服务地址' : '隧道客户端连接的本机地址'
            }}</span
            ><code>{{ endpoint }}</code
            ><AButton
              size="small"
              :disabled="dirty || (path === 'oauth' && !publicOrigin)"
              @click="copy(endpoint, '连接地址')"
              ><template #icon
                ><Icon class="settings-button-icon" name="copy" :size="15" /></template
              >复制连接地址</AButton
            >
          </div>
          <p v-if="path === 'tunnel'" class="guide-muted">
            这是同一主机内的地址，不填入 ChatGPT 的公网地址栏。若 tunnel-client
            运行在另一台主机，需由管理员配置可达地址与访问控制。
          </p>
        </li>
        <li v-if="path === 'tunnel'">
          <h4>在主机启动并保持隧道运行</h4>
          <p>
            把 OpenAI API key、隧道 ID 和 DooKnow 连接密钥交给 tunnel-client。API key 用于连接
            OpenAI；DooKnow 密钥通过 Authorization 请求头访问本机 MCP。两种密钥都不要粘贴到聊天中。
          </p>
          <details>
            <summary>在 Linux 主机终端启动</summary>
            <p>
              工具安装完成且插件已启用后，在 Bash 终端执行以下命令；两次密钥输入均隐藏。填写真实隧道
              ID，不要使用示例 ID。
            </p>
            <pre tabindex="0">{{ installation }}</pre>
            <AButton size="small" :disabled="dirty" @click="copy(installation, '启动命令')"
              ><template #icon
                ><Icon class="settings-button-icon" name="copy" :size="15" /></template
              >复制启动命令</AButton
            >
            <p>
              保持这个进程运行，通过其输出的本机管理地址查看 /ui 和
              /readyz。长期使用应请管理员将客户端设为主机服务；关闭终端可能中断连接。采用 profile
              配置时，可用 tunnel-client doctor --profile &lt;名称&gt; --explain 检查。
            </p>
          </details>
        </li>
        <li>
          <h4>在 ChatGPT 添加服务并完成连接</h4>
          <p>
            打开
            <a href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer"
              >ChatGPT 插件页面</a
            >
            → 加号 → Add custom MCP server，名称填写“DooKnow 知识库”。旧版界面可能位于设置 → Apps →
            Create；入口受账号和工作区政策限制。
          </p>
          <p v-if="path === 'oauth'">
            Connection 填写上面的 HTTPS MCP 地址（包含 /mcp），认证方式选择 OAuth。创建时会跳转到
            DooKnow，登录后核对目录和权限再同意授权。若手工 Client ID / Secret
            是可选项，保留默认自动注册；若客户端要求必填而没有注册信息，请先联系管理员，不要填登录密码或猜测密钥。
          </p>
          <p v-else>
            Connection 选择 Tunnel，选择已关联的隧道或填写它的 tunnel_id。这里使用 OpenAI 的隧道
            ID，不填本机 127.0.0.1 地址。已按上一步由隧道客户端附加 DooKnow
            密钥时，不要再把该密钥当作 OpenAI API key；按客户端显示的认证选项完成设置。
          </p>
          <p>
            核对平台提示的风险与工具权限，确认后选择 Create as a
            plugin，等待工具发现完成。旧版界面可能先使用 Scan Tools 再 Create。
          </p>
        </li>
        <li>
          <h4>发起一次读取并核对结果</h4>
          <p>
            新建 ChatGPT 对话，输入 @ 并选择
            DooKnow，发送：“请列出我有权限访问的笔记，再读取其中一篇并概括内容。”如果知识库还是空的，先返回笔记创建并保存一篇，再回来测试。
          </p>
          <p>
            核对 ChatGPT
            展示的真实笔记结果，再点“检查本机连接条件”查看最近成功调用。工具发现、授权成功和实际读取成功是不同步骤；本平台无法替你确认
            ChatGPT 对话中的结果。
          </p>
          <p v-if="!error && state?.latestSuccessfulCall" class="guide-call">
            最近工具调用：{{ state.latestSuccessfulCall.tool }} ·
            {{ new Date(state.latestSuccessfulCall.at).toLocaleString() }}。客户端可能是 ChatGPT
            或其他已授权应用。
          </p>
        </li>
      </ol>
    </details>
    <details class="guide-troubleshooting">
      <summary>遇到问题时，从哪里继续</summary>
      <ul>
        <li>没有创建入口：检查账号、工作区和自定义服务权限，必要时联系管理员。</li>
        <li>
          网页授权失败：核对部署的 HTTPS 来源、/mcp 地址和授权页可达性，重新从 ChatGPT 发起授权。
        </li>
        <li>找不到隧道：核对隧道关联的 ChatGPT 工作区、组织及 Read + Use 权限。</li>
        <li>
          工具发现或调用失败：确认插件已启用、配置已保存，隧道客户端仍运行；密钥更新后两端同步。
        </li>
        <li>没有笔记或不能修改：检查笔记已保存、分域能力及资源范围，以及客户端授权的范围。</li>
        <li>
          暂无调用记录：连接可能在授权或工具发现阶段失败，该记录只统计工具执行；请同时检查客户端和隧道诊断。
        </li>
      </ul>
    </details>
    <section v-if="mode==='tunnel' || mode==='both'" class="guide-clients" aria-label="Tunnel 客户端授权">
      <h4>Tunnel 客户端授权</h4>
      <p class="guide-muted">插件上限扩大不会改变已有 Tunnel 授权。先保存配置，再检查并授予新权限。</p>
      <AButton v-if="!tunnelPolicy" size="small" :disabled="busy || dirty || plugin.state!=='enabled'" @click="prepareTunnel">检查并更新 Tunnel 授权</AButton>
      <template v-else>
        <MCPDomainPermissions v-model="tunnelPolicy" :ceiling="tunnelCeiling" :disabled="busy || dirty" consent />
        <AButton size="small" :disabled="dirty" :loading="busy" @click="authorizeTunnel">保存 Tunnel 授权</AButton>
        <AButton size="small" :disabled="busy" @click="tunnelPolicy=undefined">取消</AButton>
      </template>
    </section>
    <section v-if="state?.clients.length" class="guide-clients" aria-label="连接授权管理">
      <h4>已授权的连接</h4>
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
    <p class="guide-sources">
      教程核对：2026-10-19 ·
      <a
        href="https://developers.openai.com/plugins/deploy/connect-chatgpt"
        target="_blank"
        rel="noopener noreferrer"
        >OpenAI 连接说明</a
      >
      ·
      <a
        href="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels"
        target="_blank"
        rel="noopener noreferrer"
        >OpenAI 隧道说明</a
      >。入口与可用能力以你的账号实际界面为准。
    </p>
  </section>
</template>
<style scoped>
.mcp-guide {
  padding: 18px;
  margin-bottom: 24px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
  background: var(--surface-soft, #fafbfc);
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
  color: var(--blue, #4566c6);
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
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 6px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.guide-muted,
.guide-sources {
  color: var(--muted, #7a8190);
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
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 6px;
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
  border-radius: 6px;
  background: var(--surface, #f5f6f8);
  font-size: 12px;
  line-height: 1.7;
}
.mcp-guide summary {
  cursor: pointer;
  color: var(--blue, #4566c6);
}
.guide-clients {
  margin-top: 20px;
}
.guide-client {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border, #e3e6ec);
  overflow-wrap: anywhere;
}
.guide-client > span {
  margin-left: 10px;
  color: var(--muted, #7a8190);
}
.guide-notice {
  color: var(--blue, #4566c6);
}
.guide-sources {
  padding-top: 14px;
  margin-top: 16px !important;
  border-top: 1px solid var(--border, #e3e6ec);
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
