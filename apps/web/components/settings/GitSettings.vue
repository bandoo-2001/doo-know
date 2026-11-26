<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Input as AInput,
  Switch as ASwitch,
} from 'ant-design-vue';
import Icon from '../Icon.vue';
import {
  featureAction,
  features,
  refreshFeatures,
  saveFeatureConfig,
  setFeatureEnabled,
} from '../../features';
import { gitStatus, refreshGitStatus } from '../../git/status';
import { gitError } from '../../git-sync';
import { ApiError } from '../../api';
import {
  gitAuthorDraft,
  hasUnsavedGitSettings,
  loadGitAuthorDraft,
} from '../../git/settings-draft';

const emit = defineEmits<{ changed: [] }>();
const git = computed(() => features.value.git);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const stale = computed(
  () => !!git.value && git.value.configVersion !== gitAuthorDraft.value?.version,
);
let active = true;
onBeforeUnmount(() => {
  active = false;
});
watch(
  git,
  (feature) => {
    if (feature) loadGitAuthorDraft(feature);
  },
  { immediate: true },
);

function readAuthors() {
  if (git.value) {
    loadGitAuthorDraft(git.value, true);
    error.value = '';
    notice.value = '';
  }
}
async function run(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await work();
  } catch (failure) {
    if (!active) return;
    error.value = gitError(failure);
    if (failure instanceof ApiError && failure.data.code === 'CONFIG_VERSION_CONFLICT')
      await refreshFeatures().catch(() => {});
  } finally {
    busy.value = false;
  }
}
async function load() {
  await refreshFeatures();
  await refreshGitStatus();
}
onMounted(() => void run(load));

function toggle(enabled: boolean) {
  void run(async () => {
    await setFeatureEnabled('git', enabled);
    if (enabled) await refreshGitStatus();
  });
}
function save() {
  const draft = gitAuthorDraft.value;
  if (!draft || stale.value) return;
  void run(async () => {
    const saved = await saveFeatureConfig(
      'git',
      {
        authorName: draft.authorName.trim(),
        authorEmail: draft.authorEmail.trim(),
      },
      draft.version,
    );
    if (!active) return;
    loadGitAuthorDraft(saved, true);
    notice.value = '提交署名已保存。';
  });
}
function initialize() {
  void run(async () => {
    await featureAction('git', 'command', 'git.initialize', { requestId: crypto.randomUUID() });
    await refreshGitStatus();
    notice.value = 'Git 仓库已初始化。';
    emit('changed');
  });
}
function acknowledge(operationId: string) {
  void run(async () => {
    await featureAction('git', 'command', 'git.acknowledge', { operationId, confirm: true });
    await refreshGitStatus();
  });
}
</script>

<template>
  <section class="settings-card" aria-label="Git 版本管理">
    <div class="settings-item-header">
      <div>
        <h2 class="settings-section-title"><Icon name="clock" :size="18" />Git 版本管理</h2>
        <p>查看修改历史、提交本地版本，并手动与关联的云端仓库同步。</p>
      </div>
      <ASwitch
        aria-label="启用 Git 版本管理"
        :checked="git?.desiredEnabled ?? false"
        :loading="busy"
        :disabled="!git || busy"
        @change="(enabled) => toggle(enabled === true)"
      />
    </div>
    <AAlert v-if="error" type="error" show-icon :message="error" />
    <AAlert v-else-if="git?.error" type="warning" show-icon :message="gitError(git.error)" />
    <div v-if="!git && error"><AButton size="small" @click="run(load)">重试读取设置</AButton></div>
    <template v-if="gitAuthorDraft">
      <form class="git-author-form" @submit.prevent="save">
        <label
          >提交作者
          <AInput v-model:value="gitAuthorDraft.authorName" :maxlength="100" :disabled="busy"
        /></label>
        <label
          >作者邮箱
          <AInput v-model:value="gitAuthorDraft.authorEmail" :maxlength="254" :disabled="busy"
        /></label>
        <AButton html-type="submit" :disabled="busy || stale || !hasUnsavedGitSettings()"
          >保存提交署名</AButton
        >
      </form>
      <p v-if="notice" role="status">{{ notice }}</p>
      <AAlert v-if="stale" type="warning" message="提交署名已在其他位置更新。"
        ><template #action
          ><AButton size="small" @click="readAuthors">载入已保存设置</AButton></template
        ></AAlert
      >
    </template>
    <template v-if="git?.state === 'enabled'">
      <p v-if="gitStatus?.repository === 'ready'">当前分支：{{ gitStatus.branch }}</p>
      <p v-else-if="gitStatus?.repository === 'missing'">尚未建立 Git 仓库</p>
      <div class="remote-actions">
        <AButton v-if="gitStatus?.repository === 'missing'" :disabled="busy" @click="initialize">
          初始化 Git 仓库（main）
        </AButton>
        <AButton size="small" :disabled="busy" @click="run(refreshGitStatus)"
          >刷新 Git 状态</AButton
        >
      </div>
      <p v-if="gitStatus?.code" role="status">{{ gitError(gitStatus.code) }}</p>
      <AAlert
        v-for="operation in gitStatus?.pending"
        :key="operation.operationId"
        type="warning"
        show-icon
        :message="`待核对提交：${operation.commit || '尚未发布'} · 请求 ${operation.requestId} · ${operation.phase}`"
        description="请在服务器核对当前分支和暂存区。"
        ><template #action>
          <AButton size="small" :disabled="busy" @click="acknowledge(operation.operationId)"
            >已核对暂存区</AButton
          >
        </template></AAlert
      >
    </template>
  </section>
</template>

<style scoped>
.git-author-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin-block: 14px;
}
.git-author-form label {
  display: grid;
  gap: 6px;
  flex: 1 1 180px;
  min-width: 0;
}
.remote-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-block: 12px;
}
</style>
