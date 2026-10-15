<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { NButton, NInput, NAlert, NCard } from 'naive-ui';
import type { PlatformStatus } from '../../shared/platform-contracts';
import { api, ApiError } from '../api';
import PluginManager from './PluginManager.vue';
const props = defineProps<{ status: PlatformStatus }>();
const emit = defineEmits<{ ready: []; refresh: [] }>();
const knowledgeRoot = ref(''), timeZone = ref('Asia/Shanghai'), error = ref(''), busy = ref(false);
const proof = ref<{ knowledgeRoot: string; validationId: string; expiresAt: string }>();
const messages: Record<string, string> = {
  FORBIDDEN_KNOWLEDGE_ROOT: '目录不在允许范围内，或与应用、运行数据和密钥目录重叠。',
  INVALID_KNOWLEDGE_ROOT: '请选择已存在、可读写的普通服务器目录，不能选择软链接。',
  KNOWLEDGE_ROOT_CHANGED: '校验后目录发生变化，请重新校验。',
  VALIDATION_EXPIRED: '目录校验已过期，请重新校验后保存。',
};
function describe(e: unknown) { return e instanceof ApiError && messages[String(e.data.code)] || (e as Error).message; }
let requestId = crypto.randomUUID(), timer: ReturnType<typeof setInterval> | undefined;
async function validate() {
  busy.value = true; error.value = '';
  try { proof.value = await api('/api/platform/setup/validate', 'POST', { knowledgeRoot: knowledgeRoot.value });
    knowledgeRoot.value = proof.value!.knowledgeRoot;
  } catch (e) { error.value = describe(e); } finally { busy.value = false; }
}
async function complete() {
  if (!proof.value) return;
  busy.value = true; error.value = '';
  try {
    await api('/api/platform/setup/complete', 'POST', { ...proof.value, timeZone: timeZone.value, requestId });
    emit('refresh');
  } catch (e) {
    error.value = describe(e);
    if (e instanceof ApiError && e.data.code === 'VALIDATION_EXPIRED') proof.value = undefined;
  } finally { busy.value = false; }
}
function changed() { proof.value = undefined; requestId = crypto.randomUUID(); }
function timeZoneChanged() { requestId = crypto.randomUUID(); }
async function finish() {
  busy.value = true;
  try { await api('/api/platform/setup/finish', 'POST', {}); emit('refresh'); }
  catch (e) { error.value = describe(e); } finally { busy.value = false; }
}
onMounted(() => { timer = setInterval(() => { if (props.status.phase === 'initializing') emit('refresh'); }, 1500); });
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <main class="platform-setup">
    <NCard title="欢迎使用 DooKnow">
      <template v-if="status.phase === 'setup_required'">
        <p>接入服务器上的知识库目录。可以选择已有资料目录或已创建的空目录。</p>
        <p class="muted">可接入目录范围：{{ status.allowedKnowledgeBases?.join('、') }}</p>
        <label for="setup-root">服务器上的知识库目录</label>
        <NInput v-model:value="knowledgeRoot" :input-props="{ id: 'setup-root', 'aria-label': '服务器上的知识库目录' }" placeholder="/home/your-name/knowledge-base" @update:value="changed" />
        <NButton :loading="busy" :disabled="!knowledgeRoot" @click="validate">校验目录</NButton>
        <NAlert v-if="proof" type="success">目录校验通过：{{ proof.knowledgeRoot }}</NAlert>
        <label for="setup-timezone">时区</label><NInput v-model:value="timeZone" :input-props="{ id: 'setup-timezone', 'aria-label': '时区' }" @update:value="timeZoneChanged" />
        <NButton type="primary" :loading="busy" :disabled="!proof" @click="complete">保存并打开知识库</NButton>
      </template>
      <template v-else-if="status.phase === 'ready'">
        <p>知识库已接入。可以现在安装插件，也可以进入知识库后在设置中配置。</p>
        <PluginManager />
        <NButton type="primary" :loading="busy" @click="finish">进入知识库</NButton>
      </template>
      <p v-else-if="status.phase === 'initializing'">正在准备知识库…</p>
      <p v-else-if="status.phase === 'owner_required'">请在服务器终端运行 dooknow install，创建初始账号。</p>
      <template v-else><NAlert type="error">知识库暂时不可用：{{ status.code || status.phase }}</NAlert>
        <p>请检查服务器目录和部署配置，修复后重启服务。已有资料和目录绑定会保留。</p></template>
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
    </NCard>
  </main>
</template>
<style scoped>
.platform-setup { max-width: 660px; margin: 8vh auto; padding: 20px; }
label { display: block; margin-top: 20px; margin-bottom: 8px; }
.n-button, .n-alert { margin-top: 14px; }
</style>
