<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue';
import { NConfigProvider, NModal, NAlert, NButton, darkTheme } from 'naive-ui';
import { ConfigProvider as AConfigProvider, theme as antAlgorithms } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import { antTheme } from './ant-design';
import type { PlatformStatus } from '../../shared/platform-contracts';
import { api, refreshCsrf } from './api';
import { initializeEditorPreferences, resolvedTheme } from './preferences';
const Login = defineAsyncComponent(() => import('./components/Login.vue'));
const Workspace = defineAsyncComponent(() => import('./components/Workspace.vue'));
const ShareReader = defineAsyncComponent(() => import('./components/ShareReader.vue'));
const SetupWizard = defineAsyncComponent(() => import('./components/SetupWizard.vue'));
const OAuthConsent = defineAsyncComponent(() => import('./components/OAuthConsent.vue'));
const token = location.pathname.startsWith('/s/') ? location.pathname.slice(3) : '',
  loggedIn = ref(false),
  mountedWorkspace = ref(false),
  expired = ref(false),
  ready = ref(false);
const platform = ref<PlatformStatus>();
const ownerId = ref('');
const username = ref('');
const activeAntTheme = computed(() => ({
  ...antTheme,
  algorithm:
    resolvedTheme.value === 'dark' ? antAlgorithms.darkAlgorithm : antAlgorithms.defaultAlgorithm,
  token: {
    ...antTheme.token,
    ...(resolvedTheme.value === 'dark'
      ? {
          colorText: '#e5e7eb',
          colorTextSecondary: '#a6b0c0',
          colorBorder: '#354158',
          colorBgLayout: '#101827',
          colorBgContainer: '#172033',
          colorPrimary: '#8ba4ff',
        }
      : {}),
  },
}));
const oauthMode =
  location.pathname === '/oauth/consent'
    ? 'consent'
    : location.pathname === '/login' && location.search
      ? 'login'
      : '';
const oauthQuery =
  new URLSearchParams(location.search).get('oauth_query') || location.search.slice(1);
const oauthError = ref(''),
  resumingOAuth = ref(false);
async function continueOAuth() {
  if (resumingOAuth.value) return;
  resumingOAuth.value = true;
  oauthError.value = '';
  try {
    const result = await api('/api/platform/mcp/oauth/continue', 'POST', {
      oauth_query: oauthQuery,
    });
    window.location.assign(result.url);
  } catch {
    oauthError.value = '无法继续授权，请回到连接客户端重新发起连接。';
    resumingOAuth.value = false;
  }
}
async function refreshPlatform() {
  platform.value = await api('/api/platform/status');
  const usable = platform.value?.phase === 'ready' && !platform.value.onboardingRequired;
  mountedWorkspace.value = !!usable && !oauthMode;
  if (usable && oauthMode === 'login') await continueOAuth();
}
const lightTheme = {
  common: {
    primaryColor: '#4566c6',
    primaryColorHover: '#5676d4',
    primaryColorPressed: '#3453ac',
    primaryColorSuppl: '#4566c6',
    borderRadius: '6px',
    textColorBase: '#262b36',
    fontFamily: 'Inter,"Noto Sans CJK SC","Microsoft YaHei",Arial,sans-serif',
  },
  Input: {
    color: '#ffffff',
    colorFocus: '#ffffff',
    border: '1px solid #dfe3eb',
    borderHover: '1px solid #a2b0db',
    boxShadowFocus: '0 0 0 3px #4566c614',
  },
  Card: {
    borderColor: '#e3e6ec',
    borderRadius: '10px',
    titleFontSizeMedium: '17px',
    titleFontWeight: '600',
    paddingMedium: '24px',
  },
  Select: { peers: { InternalSelection: { border: '1px solid #dfe3eb', color: '#ffffff' } } },
  Button: { fontWeight: '500' },
};
const activeNaiveTheme = computed(() =>
  resolvedTheme.value === 'dark'
    ? {
        common: {
          primaryColor: '#8ba4ff',
          primaryColorHover: '#a4b6ff',
          primaryColorPressed: '#7188e8',
          borderRadius: '6px',
        },
      }
    : lightTheme,
);
async function login() {
  const session = await api('/api/auth/get-session');
  if (typeof session?.user?.id !== 'string' || !session.user.id) {
    expired.value = true;
    return;
  }
  // The same owner keeps the mounted editor on reauthentication. A different
  // identity gets a new workspace and cannot inherit the previous draft scope.
  ownerId.value = session.user.id;
  username.value =
    session.user.displayUsername || session.user.username || session.user.name || '当前账户';
  initializeEditorPreferences(ownerId.value);
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
  <AConfigProvider :locale="zhCN" :theme="activeAntTheme" :auto-insert-space-in-button="false"
    ><NConfigProvider
      :theme="resolvedTheme === 'dark' ? darkTheme : null"
      :theme-overrides="activeNaiveTheme"
      ><ShareReader v-if="token" :token="token" /><template v-else-if="ready"
        ><OAuthConsent
          v-if="
            loggedIn &&
            platform?.phase === 'ready' &&
            !platform.onboardingRequired &&
            oauthMode === 'consent'
          "
          :oauth-query="oauthQuery" />
        <div
          v-else-if="
            loggedIn &&
            platform?.phase === 'ready' &&
            !platform.onboardingRequired &&
            oauthMode === 'login'
          "
          class="share-error"
        >
          <NAlert v-if="oauthError" type="error">{{ oauthError }}</NAlert>
          <p v-else>正在继续授权…</p>
          <NButton v-if="oauthError" @click="continueOAuth">重试</NButton>
        </div>
        <Workspace
          v-else-if="mountedWorkspace"
          :key="ownerId"
          :username="username"
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
    ></AConfigProvider
  >
</template>
