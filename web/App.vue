<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { NConfigProvider, NModal } from 'naive-ui';
import Login from './components/Login.vue';
import Workspace from './components/Workspace.vue';
import ShareReader from './components/ShareReader.vue';
import SetupWizard from './components/SetupWizard.vue';
import type { PlatformStatus } from '../shared/platform-contracts';
import { api, refreshCsrf } from './api';
const token = location.pathname.startsWith('/s/') ? location.pathname.slice(3) : '',
  loggedIn = ref(false),
  mountedWorkspace = ref(false),
  expired = ref(false),
  ready = ref(false);
const platform = ref<PlatformStatus>();
async function refreshPlatform() {
  platform.value = await api('/api/platform/status');
  mountedWorkspace.value = platform.value?.phase === 'ready';
}
const theme = {
  common: {
    primaryColor: '#1688ff',
    primaryColorHover: '#389cff',
    primaryColorPressed: '#0874e7',
    primaryColorSuppl: '#1688ff',
    borderRadius: '6px',
    textColorBase: '#18344f',
    fontFamily: 'Inter,"Noto Sans CJK SC","Microsoft YaHei",Arial,sans-serif',
  },
  Input: { color: '#f8fcff', border: '1px solid #d0e3f5' },
  Button: { fontWeight: '500' },
};
async function login() {
  loggedIn.value = true;
  await refreshPlatform();
  expired.value = false;
}
function sessionExpired() {
  expired.value = true;
}
onMounted(async () => {
  if (!token) {
    window.addEventListener('dooknow-session-expired', sessionExpired);
    try {
      const session = await api('/api/auth/get-session');
      if (session?.user) {
        await refreshCsrf();
        await login();
      }
    } catch {
    } finally {
      ready.value = true;
    }
  } else ready.value = true;
});
onBeforeUnmount(() => window.removeEventListener('dooknow-session-expired', sessionExpired));
</script>
<template>
  <NConfigProvider :theme-overrides="theme"
    ><ShareReader v-if="token" :token="token" /><template v-else-if="ready"
      ><Workspace
        v-if="mountedWorkspace"
        @logout="
          loggedIn = false;
          mountedWorkspace = false;
        " /><Login v-else-if="!loggedIn" @login="login" />
      <SetupWizard v-else-if="platform" :status="platform" @refresh="refreshPlatform" />
      <NModal
        :show="expired"
        :mask-closable="false"
        :close-on-esc="false"
        preset="card"
        class="dialog-card"
        :closable="false"
        ><Login compact @login="login" /></NModal
    ></template>
    <div v-else class="share-error">正在打开知识空间…</div></NConfigProvider
  >
</template>
