<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { NCard, NAlert, NButton, NCheckbox, NCheckboxGroup } from 'naive-ui';
import { api } from '../api';
const props = defineProps<{ oauthQuery: string }>();
const request = ref<any>(), scopes = ref<string[]>([]), prefixes = ref<string[]>([]), busy = ref(false), error = ref('');
const labels: Record<string, string> = { 'knowledge:read': '读取所选目录中的资料', 'knowledge:write': '创建、修改和归档资料',
  'knowledge:index': '检查和刷新检索索引', offline_access: '保持连接，允许刷新访问令牌' };
onMounted(async () => {
  try {
    request.value = await api('/api/platform/mcp/oauth/request', 'POST', { oauth_query: props.oauthQuery });
    scopes.value = request.value.allowedScopes.filter((s: string) => ['knowledge:read','offline_access'].includes(s));
    prefixes.value = [...request.value.allowedPrefixes];
  } catch { error.value = '授权请求无效或已过期，请回到连接客户端重新发起授权。'; }
});
async function consent(accept: boolean) {
  busy.value = true; error.value = '';
  try { const result = await api('/api/platform/mcp/oauth/consent', 'POST', { accept, oauth_query: props.oauthQuery,
    scopes: scopes.value, allowedPrefixes: prefixes.value }); window.location.assign(result.url); }
  catch { error.value = '授权未完成，请重新发起连接。'; } finally { busy.value = false; }
}
</script>
<template>
  <main class="oauth-consent"><NCard title="连接 DooKnow">
    <template v-if="request"><h2>{{ request.clientName }}</h2><p>该连接请求访问你的知识库。请选择允许的操作与目录。</p>
      <h3>允许的操作</h3><NCheckboxGroup v-model:value="scopes"><div v-for="scope in request.allowedScopes" :key="scope"><NCheckbox :value="scope">{{ labels[scope] || scope }}</NCheckbox></div></NCheckboxGroup>
      <h3>允许的目录</h3><NCheckboxGroup v-model:value="prefixes"><div v-for="prefix in request.allowedPrefixes" :key="prefix"><NCheckbox :value="prefix">{{ prefix }}</NCheckbox></div></NCheckboxGroup>
      <p class="muted">未选中的目录不会开放。可随时在 MCP 插件设置中撤销连接。</p>
      <NButton type="primary" :loading="busy" :disabled="!prefixes.length || !scopes.some(s => s.startsWith('knowledge:'))" @click="consent(true)">允许访问</NButton>
      <NButton :disabled="busy" @click="consent(false)">拒绝</NButton>
    </template>
    <NAlert v-if="error" type="error">{{ error }}</NAlert><p v-else-if="!request">正在检查授权请求…</p>
  </NCard></main>
</template>
<style scoped>.oauth-consent { max-width: 680px; padding: 20px; margin: 5vh auto; }.n-button { margin: 16px 12px 0 0; }h3 { margin-top: 24px; }</style>
