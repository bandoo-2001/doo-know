<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { NConfigProvider, NModal, NAlert, NButton } from 'naive-ui';
import Login from './components/Login.vue';
import Workspace from './components/Workspace.vue';
import ShareReader from './components/ShareReader.vue';
import SetupWizard from './components/SetupWizard.vue';
import OAuthConsent from './components/OAuthConsent.vue';
import type { PlatformStatus } from '../shared/platform-contracts';
import { api, refreshCsrf } from './api';
const token = location.pathname.startsWith('/s/') ? location.pathname.slice(3) : '',
  loggedIn = ref(false),
  mountedWorkspace = ref(false),
  expired = ref(false),
  ready = ref(false);
const platform = ref<PlatformStatus>();
const oauthMode = location.pathname === '/oauth/consent' ? 'consent' : location.pathname === '/login' && location.search ? 'login' : '';
const oauthQuery = new URLSearchParams(location.search).get('oauth_query') || location.search.slice(1);
const oauthError = ref(''), resumingOAuth = ref(false);
async function continueOAuth() {
  if (resumingOAuth.value) return;
  resumingOAuth.value = true; oauthError.value = '';
  try { const result = await api('/api/platform/mcp/oauth/continue', 'POST', { oauth_query: oauthQuery }); window.location.assign(result.url); }
  catch { oauthError.value = '无法继续授权，请回到连接客户端重新发起连接。'; resumingOAuth.value = false; }
}
async function refreshPlatform() {
  platform.value = await api('/api/platform/status');
  const usable = platform.value?.phase === 'ready' && !platform.value.onboardingRequired;
  mountedWorkspace.value = !!usable && !oauthMode;
  if (usable && oauthMode === 'login') await continueOAuth();
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
      ><OAuthConsent v-if="loggedIn && platform?.phase === 'ready' && !platform.onboardingRequired && oauthMode === 'consent'" :oauth-query="oauthQuery" />
      <div v-else-if="loggedIn && platform?.phase === 'ready' && !platform.onboardingRequired && oauthMode === 'login'" class="share-error">
        <NAlert v-if="oauthError" type="error">{{ oauthError }}</NAlert><p v-else>正在继续授权…</p><NButton v-if="oauthError" @click="continueOAuth">重试</NButton>
      </div>
      <Workspace
        v-else-if="mountedWorkspace"
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
