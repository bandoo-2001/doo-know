<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { Alert as AAlert, Button as AButton, Input as AInput, Select as ASelect } from 'ant-design-vue';
import type { McpApiClientView } from '../../../shared/mcp-api-contracts';
import type { PermissionPolicy } from '../../../shared/permissions';
import { api } from '../api';
import { defaultConsentPolicy, describePermissionPolicy, policyScopes, validConsentPolicy } from '../mcp-permissions';
import MCPDomainPermissions from './MCPDomainPermissions.vue';

const props = defineProps<{ disabled?: boolean }>();
type EditKind = 'create' | 'rename' | 'permissions' | 'rotate' | 'reauthorize';
interface ClientForm {
  kind: EditKind;
  clientId?: string;
  name: string;
  expiry: string;
  expiresAtCustom: string;
  permissionPolicy?: PermissionPolicy;
  ceiling?: PermissionPolicy;
  expectedVersion?: number;
  expectedGrantVersion?: number;
}
const componentId = useId();
const clients = ref<McpApiClientView[]>([]),
  form = ref<ClientForm>();
const busy = ref(false),
  reading = ref(false),
  error = ref(''),
  notice = ref('');
const secret = ref(''),
  secretClientId = ref(''),
  pendingRevoke = ref('');
const conflict = ref(false);
let active = true,
  readSequence = 0,
  mutationEpoch = 0;
onBeforeUnmount(() => {
  active = false;
  secret.value = '';
  secretClientId.value = '';
  form.value = undefined;
});
const expiryOptions = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天（默认）' },
  { value: 'custom', label: '自定义时间' },
  { value: 'forever', label: '永不过期' },
];
const titles: Record<EditKind, string> = {
  create: '创建 API 客户端',
  rename: '修改客户端名称',
  permissions: '编辑客户端权限',
  rotate: '轮换 API Key',
  reauthorize: '重新授权并签发',
};
const editsPolicy = computed(
  () => !!form.value && ['create', 'permissions', 'reauthorize'].includes(form.value.kind),
);
const issuesKey = computed(
  () => !!form.value && ['create', 'rotate', 'reauthorize'].includes(form.value.kind),
);
const canSubmit = computed(
  () =>
    !!form.value &&
    !busy.value &&
    !conflict.value &&
    (form.value.kind === 'rename' || !props.disabled) &&
    (!['create', 'rename'].includes(form.value.kind) || !!form.value.name.trim()) &&
    (!editsPolicy.value || validConsentPolicy(form.value.permissionPolicy)),
);
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
async function load() {
  const sequence = ++readSequence,
    epoch = mutationEpoch;
  reading.value = true;
  try {
    const result = await api<{ items: McpApiClientView[] }>('/api/platform/mcp/api-clients');
    if (!active || sequence !== readSequence || epoch !== mutationEpoch) return false;
    clients.value = result.items;
    if (
      pendingRevoke.value &&
      clients.value.some(
        (client) => client.clientId === pendingRevoke.value && client.status === 'revoked',
      )
    ) {
      pendingRevoke.value = '';
      notice.value = '已核对：连接已撤销。';
    }
    if (!form.value) error.value = '';
    return true;
  } catch {
    if (active && sequence === readSequence && epoch === mutationEpoch)
      error.value = '暂时无法读取 API 客户端，请刷新重试。';
    return false;
  } finally {
    if (active && sequence === readSequence) reading.value = false;
  }
}
async function beginCreate() {
  if (busy.value || props.disabled || secret.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  conflict.value = false;
  try {
    const inventory = await api<{ policy: PermissionPolicy }>('/api/platform/mcp/permissions');
    if (!active) return;
    form.value = {
      kind: 'create',
      name: '',
      expiry: '90',
      expiresAtCustom: '',
      ceiling: inventory.policy,
      permissionPolicy: defaultConsentPolicy(inventory.policy, policyScopes(inventory.policy)),
    };
  } catch {
    if (active) error.value = '暂时无法读取当前权限，请刷新后重试。';
  } finally {
    if (active) busy.value = false;
  }
}
async function beginEdit(client: McpApiClientView, kind: Exclude<EditKind, 'create'>) {
  if (
    busy.value ||
    secret.value ||
    (props.disabled && kind !== 'rename') ||
    (kind === 'reauthorize'
      ? client.status !== 'requires_reauthorization'
      : kind !== 'rename' && client.status !== 'active')
  )
    return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  conflict.value = false;
  try {
    let ceiling: PermissionPolicy | undefined;
    if (kind === 'permissions' || kind === 'reauthorize')
      ceiling = (await api<{ policy: PermissionPolicy }>('/api/platform/mcp/permissions')).policy;
    if (!active) return;
    const permissionPolicy =
      kind === 'reauthorize' && ceiling
        ? defaultConsentPolicy(ceiling, policyScopes(ceiling))
        : clone(client.permissionPolicy);
    if (kind === 'permissions' && ceiling) {
      for (const [domain, grant] of Object.entries(ceiling.domains)) {
        if (!permissionPolicy.domains[domain])
          permissionPolicy.domains[domain] = { ...clone(grant), enabled: false, actions: [] };
      }
    }
    form.value = {
      kind,
      clientId: client.clientId,
      name: client.name,
      expiry: '90',
      expiresAtCustom: '',
      expectedVersion: client.version,
      expectedGrantVersion: client.grantVersion,
      ceiling,
      permissionPolicy,
    };
  } catch {
    if (active) error.value = '暂时无法读取当前权限，请刷新后重试。';
  } finally {
    if (active) busy.value = false;
  }
}
function expiration(current: ClientForm): string | null {
  if (current.expiry === 'forever') return null;
  if (current.expiry !== 'custom')
    return new Date(Date.now() + Number(current.expiry) * 86400000).toISOString();
  const date = new Date(current.expiresAtCustom);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())
    throw Error('请选择将来的到期时间。');
  return date.toISOString();
}
function replace(client: McpApiClientView) {
  const index = clients.value.findIndex((item) => item.clientId === client.clientId);
  if (index < 0) clients.value = [...clients.value, client];
  else
    clients.value = clients.value.map((item) =>
      item.clientId === client.clientId ? client : item,
    );
}
async function submit() {
  if (!canSubmit.value || !form.value) return;
  const current = form.value;
  let expiresAt: string | null | undefined;
  try {
    if (issuesKey.value) expiresAt = expiration(current);
  } catch (failure) {
    error.value = (failure as Error).message;
    return;
  }
  busy.value = true;
  error.value = '';
  notice.value = '';
  ++mutationEpoch;
  const base = '/api/platform/mcp/api-clients';
  const target = base + '/' + encodeURIComponent(current.clientId || '');
  try {
    let response: McpApiClientView | { client: McpApiClientView; key: string };
    if (current.kind === 'create')
      response = await api(base, 'POST', {
        name: current.name.trim(),
        permissionPolicy: current.permissionPolicy,
        expiresAt,
      });
    else if (current.kind === 'rename')
      response = await api(target, 'PATCH', {
        name: current.name.trim(),
        expectedVersion: current.expectedVersion,
      });
    else if (current.kind === 'permissions')
      response = await api(target + '/permissions', 'PUT', {
        permissionPolicy: current.permissionPolicy,
        expectedGrantVersion: current.expectedGrantVersion,
      });
    else if (current.kind === 'rotate')
      response = await api(target + '/rotate-key', 'POST', {
        expiresAt,
        expectedVersion: current.expectedVersion,
      });
    else
      response = await api(target + '/reauthorize', 'POST', {
        permissionPolicy: current.permissionPolicy,
        expiresAt,
        expectedVersion: current.expectedVersion,
        expectedGrantVersion: current.expectedGrantVersion,
      });
    if (!active) return;
    if ('client' in response) {
      replace(response.client);
      secret.value = response.key;
      secretClientId.value = response.client.clientId;
    } else replace(response);
    form.value = undefined;
    notice.value =
      current.kind === 'permissions'
        ? '客户端权限已更新，后续调用立即使用新权限。'
        : current.kind === 'rename'
          ? '客户端名称已更新。'
          : '新密钥已签发，请立即复制保存。';
  } catch (failure) {
    if (!active) return;
    if ((failure as { status?: number }).status === 409) {
      conflict.value = true;
      error.value = '客户端或授权已经变化，当前输入已保留。请重新载入后检查并保存。';
    } else
      error.value = '操作结果尚未确认。请先刷新客户端列表核对；若密钥已签发但未显示，请轮换密钥。';
  } finally {
    if (active) busy.value = false;
  }
}
async function reloadForm() {
  const current = form.value;
  if (!current || busy.value) return;
  if (!(await load()) || !active) return;
  const client = clients.value.find((item) => item.clientId === current.clientId);
  if (client && current.kind !== 'create') await beginEdit(client, current.kind);
  else {
    form.value = undefined;
    conflict.value = false;
  }
}
async function revoke(client: McpApiClientView) {
  if (busy.value || client.status === 'revoked') return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  ++mutationEpoch;
  try {
    await api(
      '/api/platform/mcp/api-clients/' + encodeURIComponent(client.clientId) + '/revoke',
      'POST',
      {},
    );
    if (!active) return;
    replace({
      ...client,
      status: 'revoked',
      version: client.version + 1,
      key: client.key ? { ...client.key, revokedAt: new Date().toISOString() } : null,
    });
    if (secretClientId.value === client.clientId) dismissSecret();
    if (form.value?.clientId === client.clientId) form.value = undefined;
    pendingRevoke.value = '';
    notice.value = '连接已撤销，原密钥和授权立即失效。';
  } catch {
    if (active) error.value = '撤销结果尚未确认，请刷新客户端列表后核对。';
  } finally {
    if (active) busy.value = false;
  }
}
function dismissSecret() {
  secret.value = '';
  secretClientId.value = '';
}
async function copySecret() {
  try {
    await navigator.clipboard.writeText(secret.value);
    if (active) notice.value = 'API Key 已复制。';
  } catch {
    if (active) error.value = '无法自动复制，请选中密钥手动复制。';
  }
}
function status(client: McpApiClientView) {
  if (client.status === 'revoked') return '已撤销';
  if (client.status === 'requires_reauthorization') return '需要重新授权';
  if (client.key?.expiresAt && Date.parse(client.key.expiresAt) <= Date.now()) return '密钥已到期';
  return '已授权';
}
function date(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : '尚无记录';
}
onMounted(load);
</script>
<template>
  <section class="api-clients" aria-label="API Key 客户端">
    <header>
      <div>
        <h4>API Key 客户端</h4>
        <p>每个客户端独立设置资源权限、有效期和撤销。完整密钥仅在签发后显示一次。</p>
      </div>
      <div class="client-actions">
        <AButton size="small" :loading="reading" :disabled="busy" @click="load"
          >刷新 API 客户端</AButton
        ><AButton
          size="small"
          :disabled="busy || disabled || !!form || !!secret"
          @click="beginCreate"
          >创建 API 客户端</AButton
        >
      </div>
    </header>
    <AAlert v-if="error" type="warning" show-icon :message="error" />
    <div v-if="secret" class="one-time-secret" role="region" aria-label="一次性 API Key">
      <strong>请立即复制密钥并妥善保存，关闭后无法再次查看。</strong>
      <AInput.TextArea
        :value="secret"
        readonly
        aria-label="新 API Key"
        :auto-size="{ minRows: 2, maxRows: 4 }"
        autocomplete="off"
        spellcheck="false"
      />
      <div class="client-actions">
        <AButton size="small" @click="copySecret">复制 API Key</AButton
        ><AButton size="small" @click="dismissSecret">已保存，关闭密钥</AButton>
      </div>
    </div>
    <form v-if="form" class="client-form" :aria-label="titles[form.kind]" @submit.prevent="submit">
      <h4>{{ titles[form.kind] }}</h4>
      <template v-if="form.kind === 'create' || form.kind === 'rename'"
        ><label :for="componentId + '-name'">客户端名称</label
        ><AInput
          :id="componentId + '-name'"
          v-model:value="form.name"
          aria-label="客户端名称"
          :maxlength="100"
          :disabled="busy"
          autocomplete="off"
      /></template>
      <template v-if="issuesKey">
        <label :for="componentId + '-expiry'">密钥有效期</label
        ><ASelect
          :id="componentId + '-expiry'"
          v-model:value="form.expiry"
          :options="expiryOptions"
          aria-label="密钥有效期"
          :disabled="busy"
        />
        <template v-if="form.expiry === 'custom'"
          ><label :for="componentId + '-custom'">自定义到期时间</label
          ><input
            :id="componentId + '-custom'"
            v-model="form.expiresAtCustom"
            type="datetime-local"
            aria-label="自定义到期时间"
            :disabled="busy"
        /></template>
        <p v-if="form.kind === 'rotate'">签发后旧密钥立即失效；客户端身份和已授予权限保持不变。</p>
        <p v-if="form.expiry === 'forever'">密钥没有到期时间；仍可随时撤销或轮换。</p>
      </template>
      <MCPDomainPermissions
        v-if="editsPolicy"
        v-model="form.permissionPolicy"
        :ceiling="form.ceiling"
        :disabled="busy || disabled"
        consent
      />
      <div class="client-actions">
        <AButton
          html-type="submit"
          type="primary"
          size="small"
          :disabled="!canSubmit"
          :loading="busy"
          >{{
            titles[form.kind] === '创建 API 客户端'
              ? '创建并签发密钥'
              : form.kind === 'permissions'
                ? '保存客户端权限'
                : form.kind === 'rename'
                  ? '保存客户端名称'
                  : '确认' + titles[form.kind]
          }}</AButton
        ><AButton v-if="conflict" size="small" :disabled="busy" @click="reloadForm"
          >重新载入客户端</AButton
        ><AButton
          size="small"
          :disabled="busy"
          @click="
            form = undefined;
            conflict = false;
            error = '';
          "
          >取消</AButton
        >
      </div>
    </form>
    <p v-if="!clients.length && !reading">尚无 API Key 客户端。</p>
    <article
      v-for="client in clients"
      :key="client.clientId"
      class="api-client"
      :aria-label="client.name"
    >
      <div class="client-title">
        <strong>{{ client.name }}</strong
        ><span>{{ status(client) }}</span>
      </div>
      <p>已授予：{{ describePermissionPolicy(client.permissionPolicy) }}</p>
      <p v-if="client.effectivePolicy">
        当前生效：{{ describePermissionPolicy(client.effectivePolicy) }}
      </p>
      <p v-if="client.key">
        密钥尾号：{{ client.key.suffix }} · 到期：{{
          client.key.expiresAt ? date(client.key.expiresAt) : '永不过期'
        }}<br />签发：{{ date(client.key.createdAt) }} · 最近使用：{{ date(client.key.lastUsedAt) }}
      </p>
      <div class="client-actions">
        <AButton
          size="small"
          :disabled="busy || !!form || !!secret"
          @click="beginEdit(client, 'rename')"
          >修改名称</AButton
        >
        <template v-if="client.status === 'active'"
          ><AButton
            size="small"
            :disabled="busy || disabled || !!form || !!secret"
            @click="beginEdit(client, 'permissions')"
            >编辑权限</AButton
          ><AButton
            size="small"
            :disabled="busy || disabled || !!form || !!secret"
            @click="beginEdit(client, 'rotate')"
            >轮换密钥</AButton
          ></template
        >
        <AButton
          v-if="client.status === 'requires_reauthorization'"
          size="small"
          :disabled="busy || disabled || !!form || !!secret"
          @click="beginEdit(client, 'reauthorize')"
          >重新授权并签发</AButton
        >
        <AButton
          v-if="client.status !== 'revoked' && pendingRevoke !== client.clientId"
          size="small"
          danger
          :disabled="busy"
          @click="pendingRevoke = client.clientId"
          >撤销 API 连接</AButton
        >
      </div>
      <div v-if="pendingRevoke === client.clientId" class="client-actions">
        <span>撤销后该客户端无法继续访问。</span
        ><AButton size="small" danger :loading="busy" @click="revoke(client)"
          >确认撤销 API 连接</AButton
        ><AButton size="small" :disabled="busy" @click="pendingRevoke = ''">取消</AButton>
      </div>
    </article>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>
<style scoped>
.api-clients {
  display: grid;
  gap: 14px;
  min-width: 0;
  margin-top: 20px;
}
.api-clients header,
.client-title {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}
.api-clients h4 {
  margin: 0;
}
.api-clients p {
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  margin: 6px 0;
  color: var(--muted);
}
.client-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.api-client,
.client-form,
.one-time-secret {
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
  padding: 14px;
  min-width: 0;
}
.client-form,
.one-time-secret {
  display: grid;
  gap: 10px;
}
.client-form :deep(.ant-select) {
  width: 100%;
}
.client-form input[type='datetime-local'] {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
  max-width: 100%;
  background: var(--panel);
  color: var(--text);
  font: inherit;
}
.client-form input[type='datetime-local']:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.client-title strong {
  overflow-wrap: anywhere;
}
.client-title span {
  font-size: 12px;
  color: var(--muted);
}
.one-time-secret :deep(textarea) {
  font-family: monospace;
  overflow-wrap: anywhere;
}
</style>
