<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Alert as AAlert, Button as AButton, Switch as ASwitch } from 'ant-design-vue';
import Icon from '../Icon.vue';
import { featureAction, features, refreshFeatures, setFeatureEnabled } from '../../features';
import { gitStatus, refreshGitStatus } from '../../git/status';
import { gitError } from '../../git-sync';
import SettingsTabs from './SettingsTabs.vue';
import GitAuthorForm from './GitAuthorForm.vue';
import GitRemotePanel from '../GitRemotePanel.vue';
const emit = defineEmits<{ changed: [] }>();
const tabs = [
  { key: 'local', label: '本地与署名' },
  { key: 'remote', label: '云端同步' },
] as const;
const activeTab = ref<(typeof tabs)[number]['key']>('local');
const git = computed(() => features.value.git);
const busy = ref(false);
const error = ref('');
const notice = ref('');
let active = true;
onBeforeUnmount(() => {
  active = false;
});
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
  <div class="settings-stack">
    <section class="settings-card" aria-label="Git 版本管理">
      <div class="settings-item-header settings-feature-heading">
        <div>
          <h2 class="settings-section-title"><Icon name="clock" :size="18" />本地版本记录</h2>
          <p>启用后可以提交和查看知识库的修改历史。</p>
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
      <div v-if="!git && error">
        <AButton size="small" @click="run(load)">重试读取设置</AButton>
      </div>
      <p v-if="notice" role="status">{{ notice }}</p>
    </section>
    <SettingsTabs
      v-if="git"
      v-model="activeTab"
      :tabs="tabs"
      label="Git 管理选项"
      panel-class="settings-stack"
    >
      <template #default="{ tab }">
        <template v-if="tab.key === 'local'">
          <section v-if="git" class="settings-card" aria-label="Git 提交署名">
            <h2 class="settings-section-title">提交署名</h2>
            <p class="settings-muted">姓名和邮箱会显示在这个知识库的提交记录中。</p>
            <GitAuthorForm />
          </section>
          <section v-if="git?.state === 'enabled'" class="settings-card">
            <h2 class="settings-section-title"><Icon name="git-branch" :size="18" />本地仓库</h2>
            <p v-if="gitStatus?.repository === 'ready'">当前分支：{{ gitStatus.branch }}</p>
            <p v-else-if="gitStatus?.repository === 'missing'">尚未建立 Git 仓库</p>
            <div class="remote-actions">
              <AButton
                v-if="gitStatus?.repository === 'missing'"
                :disabled="busy"
                @click="initialize"
              >
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
          </section>
        </template>
        <template v-else>
          <section v-if="git?.state === 'enabled'" class="settings-card">
            <GitRemotePanel @changed="emit('changed')" />
          </section>
          <p v-if="git.state !== 'enabled'" class="settings-card settings-muted">
            启用 Git 版本管理后可关联云端仓库。
          </p>
        </template>
      </template>
    </SettingsTabs>
  </div>
</template>

<style scoped>
.remote-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-block: 12px;
}
</style>
