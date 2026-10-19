<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import type { MCPConnectionState } from '../../../shared/mcp-connection-contracts';
import { api } from '../api';
import { pluginRegistry } from '../plugins';
const clients = ref<MCPConnectionState['clients']>([]);
const actionError = ref('');
let readGeneration = 0;
const error = ref(''),
  notice = ref(''),
  pending = ref(''),
  busy = ref(false);
async function load() {
  const generation = ++readGeneration;
  try {
    const current = (await api<MCPConnectionState>('/api/platform/mcp/connection')).clients;
    if (generation !== readGeneration) return;
    clients.value = current;
    error.value = '';
    if (
      actionError.value &&
      pending.value &&
      current.some((client) => client.clientId === pending.value && !client.active)
    ) {
      pending.value = '';
      actionError.value = '';
      notice.value = '已核对：连接授权已撤销。';
    }
  } catch {
    if (generation === readGeneration) error.value = '暂时无法读取连接授权，请重试。';
  }
}
async function revoke() {
  if (busy.value) return;
  busy.value = true;
  actionError.value = '';
  try {
    const result = await api('/api/platform/mcp/clients/revoke', 'POST', {
      clientId: pending.value,
    });
    ++readGeneration;
    clients.value = clients.value.map((client) =>
      client.clientId === pending.value
        ? { ...client, active: false, effectiveScopes: [], effectivePrefixes: [] }
        : client,
    );
    pending.value = '';
    notice.value = result.cleanupPending
      ? '授权已撤销，令牌清理待重试。'
      : '连接授权已撤销，再次使用需要重新授权。';
    await load();
  } catch {
    actionError.value = '未能确认撤销结果，请刷新授权列表后重试。';
  } finally {
    busy.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  readGeneration++;
});
watch(
  () =>
    pluginRegistry.value.installed.map((p) => `${p.id}:${p.state}:${p.configVersion}`).join(','),
  load,
);
</script>
<template>
  <section
    v-if="clients.length || error || actionError"
    class="authorization-card"
    aria-label="停用或卸载后的连接授权"
  >
    <h2>保留的连接授权</h2>
    <p>
      插件停用或卸载会暂停访问，但保留客户端授权。重新安装启用后，授权可能继续使用；你也可以在这里撤销。
    </p>
    <AAlert v-if="error || actionError" type="warning" :message="error || actionError" />
    <AButton v-if="error || actionError" size="small" :disabled="busy" @click="load"
      >重新读取授权</AButton
    >
    <div v-for="client in clients" :key="client.clientId" class="authorization-row">
      <strong>{{ client.clientId }}</strong
      ><span>{{ client.active ? '授权保留' : '已撤销' }}</span>
      <AButton
        v-if="client.active && pending !== client.clientId"
        size="small"
        :disabled="busy"
        @click="pending = client.clientId"
        >撤销连接授权</AButton
      >
      <div v-if="pending === client.clientId" class="authorization-actions">
        <span>撤销后，此客户端无法继续使用原授权。</span
        ><AButton size="small" danger :loading="busy" @click="revoke">确认撤销授权</AButton
        ><AButton size="small" :disabled="busy" @click="pending = ''">取消</AButton>
      </div>
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>
<style scoped>
.authorization-card {
  margin-top: 20px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 8px;
  min-width: 0;
}
.authorization-card h2 {
  margin: 0 0 8px;
  font-size: 16px;
}
.authorization-card p {
  font-size: 13px;
  line-height: 1.7;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.authorization-row,
.authorization-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 12px;
  font-size: 13px;
}
.authorization-row > strong {
  min-width: 0;
  overflow-wrap: anywhere;
}
.authorization-actions {
  flex-basis: 100%;
}
</style>
