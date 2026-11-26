<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Tabs as ATabs,
  TabPane as ATabPane,
} from 'ant-design-vue';
import type { KnowledgeSourceProblem, PlatformStatus } from '../../../shared/platform-contracts';
import SettingsOverlay from './settings/SettingsOverlay.vue';
import AccountSettings from './settings/AccountSettings.vue';
import AboutSettings from './settings/AboutSettings.vue';
import EditorSettings from './settings/EditorSettings.vue';

const props = defineProps<{
  status: PlatformStatus;
  username: string;
  checking?: boolean;
  logoutBusy?: boolean;
  logoutError?: string;
}>();
const emit = defineEmits<{ refresh: []; logout: [] }>();
const reasons: Record<KnowledgeSourceProblem, string> = {
  missing: '找不到绑定目录。请检查原目录是否已移动，以及存储设备是否已挂载。',
  replaced: '这个路径现在指向另一个目录。请核对原知识库的位置或磁盘挂载。',
  symlink: '绑定目录现在是符号链接。请检查原目录的位置。',
  not_directory: '绑定路径现在不是文件夹。请检查原目录的位置。',
  permission_denied: '服务账号没有权限读取绑定目录。请检查目录和挂载权限。',
  unavailable: '暂时无法读取绑定目录。请检查原目录和磁盘是否可用。',
};
const reason = computed(() =>
  props.status.sourceProblem
    ? reasons[props.status.sourceProblem]
    : props.status.phase === 'configuration_error'
      ? '知识库绑定与部署配置冲突，请核对服务使用的配置和原文目录。'
      : '知识库服务暂时不可用，请检查保存位置和服务状态。',
);
const open = ref(false);
const tab = ref('about');
const requested = ref(false);
const checked = ref(false);
watch(
  () => props.checking,
  (checking, previous) => {
    if (!checking && previous && requested.value) {
      checked.value = true;
      requested.value = false;
    }
  },
);
function recheck() {
  checked.value = false;
  requested.value = true;
  emit('refresh');
}
</script>

<template>
  <section class="unavailable-library setup-state" aria-labelledby="unavailable-heading">
    <h1 id="unavailable-heading">暂时无法打开知识库</h1>
    <p>{{ reason }}</p>
    <p v-if="status.knowledgeRoot" class="bound-path">
      <strong>绑定目录</strong> <code>{{ status.knowledgeRoot }}</code>
    </p>
    <div class="actions">
      <AButton type="primary" :loading="checking" :disabled="logoutBusy" @click="recheck"
        >重新检查</AButton
      >
      <AButton :disabled="logoutBusy" @click="open = true">打开设置与诊断</AButton>
      <AButton :loading="logoutBusy" :disabled="checking" @click="emit('logout')">退出登录</AButton>
    </div>
    <p v-if="checked" role="status">已重新检查，知识库仍未就绪。</p>
    <AAlert v-if="logoutError" type="error" show-icon :message="logoutError" />
    <details>
      <summary>查看详细信息</summary>
      <code>{{ status.code || status.phase }}</code>
    </details>

    <SettingsOverlay v-model:show="open" kind="drawer" title="设置与诊断" icon="settings">
      <AAlert v-if="logoutError" type="error" show-icon :message="logoutError" />
      <ATabs v-model:active-key="tab" :destroy-inactive-tab-pane="true">
        <ATabPane key="about" tab="关于与诊断"><AboutSettings /></ATabPane>
        <ATabPane key="account" tab="账号与安全"
          ><AccountSettings :username="username" @logout="emit('logout')"
        /></ATabPane>
        <ATabPane key="editor" tab="通用与编辑"><EditorSettings /></ATabPane>
      </ATabs>
    </SettingsOverlay>
  </section>
</template>

<style scoped>
.unavailable-library h1 {
  margin: 0 0 12px;
  font-size: 25px;
}
.unavailable-library p {
  margin: 8px 0;
  line-height: 1.7;
}
.bound-path {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  overflow-wrap: anywhere;
}
.bound-path code {
  min-width: 0;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 18px 0;
}
details {
  margin-top: 14px;
}
summary {
  cursor: pointer;
}
</style>
