<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, defineAsyncComponent, defineComponent, h } from 'vue';
import { NConfigProvider, NModal, NAlert, NButton, darkTheme } from 'naive-ui';
import { ConfigProvider as AConfigProvider, theme as antAlgorithms } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import { antTheme } from './ant-design';
import type { PlatformStatus } from '../../shared/platform-contracts';
import { api, ApiError, refreshCsrf, resetCsrf } from './api';
import { clearPluginDrafts, hasUnsavedPluginDrafts } from './plugin-drafts';
import { disposePluginUIs } from './plugins';
import { initializeEditorPreferences, resolvedTheme } from './preferences';
import { initializeAppShortcuts } from './app-shortcuts';
import LoadingState from './components/LoadingState.vue';
const PageLoading = defineComponent({
  inheritAttrs: false,
  setup: () => () => h(LoadingState, { variant: 'page', label: '正在打开知识空间…' }),
});
const LoginLoading = defineComponent({
  inheritAttrs: false,
  props: { compact: Boolean },
  setup: (props) => () => h(LoadingState, {
    variant: props.compact ? 'inline' : 'page',
    label: '正在加载登录…',
  }),
});
const PageLoadError = defineComponent({
  inheritAttrs: false,
  props: { compact: Boolean },
  setup: (props) => () => h('section', {
    class: props.compact ? 'editor-warning' : 'share-error',
    role: 'alert',
  }, [
    h('p', '界面暂时无法加载。'),
    h('p', props.compact ? '请检查网络连接，稍后重试登录。' : '请检查网络连接后重新打开此页面。'),
  ]),
});
const asyncPageOptions = {
  loadingComponent: PageLoading,
  errorComponent: PageLoadError,
  delay: 160,
};
const Login = defineAsyncComponent({
  ...asyncPageOptions,
  loader: () => import('./components/Login.vue'),
  loadingComponent: LoginLoading,
});
const loadWorkspace = () => import('./components/Workspace.vue');
const Workspace = defineAsyncComponent({ ...asyncPageOptions, loader: loadWorkspace });
const ShareReader = defineAsyncComponent({
  ...asyncPageOptions,
  loader: () => import('./components/ShareReader.vue'),
});
const SetupWizard = defineAsyncComponent({
  ...asyncPageOptions,
  loader: () => import('./components/SetupWizard.vue'),
});
const OAuthConsent = defineAsyncComponent({
  ...asyncPageOptions,
  loader: () => import('./components/OAuthConsent.vue'),
});
const token = location.pathname.startsWith('/s/') ? location.pathname.slice(3) : '',
  loggedIn = ref(false),
  mountedWorkspace = ref(false),
  expired = ref(false),
  ready = ref(false);
const sessionCheckBusy = ref(false),
  sessionCheckError = ref('');
const platform = ref<PlatformStatus>();
const platformError = ref(''),
  platformBusy = ref(false),
  platformLogoutBusy = ref(false),
  platformLogoutError = ref('');
const workspaceServiceUnavailable = computed(() =>
  platform.value && platform.value.phase !== 'ready'
    ? '知识库服务尚未就绪，当前编辑和本地草稿已保留，暂时无法保存到服务器。请检查服务后重试。'
    : '',
);
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
type PlatformRead = { ok: true; status: PlatformStatus } | { ok: false; cause: unknown };
async function readPlatform(): Promise<PlatformRead> {
  try {
    return {
      ok: true,
      status: await api<PlatformStatus>('/api/platform/status', 'GET', undefined, {
        notifySessionExpired: false,
      }),
    };
  } catch (cause) {
    // The initial read may finish before CSRF, including a rejected response.
    // Hold that outcome until the checks permit accepting the session.
    return { ok: false, cause };
  }
}
async function completePlatformRead(prepared?: Promise<PlatformRead>) {
  if (platformBusy.value || platformLogoutBusy.value) return;
  platformBusy.value = true;
  platformError.value = '';
  platformLogoutError.value = '';
  try {
    const result = await (prepared || readPlatform());
    if (!result.ok) throw result.cause;
    platform.value = result.status;
    const usable = platform.value?.phase === 'ready' && !platform.value.onboardingRequired;
    if (!mountedWorkspace.value) mountedWorkspace.value = !!usable && !oauthMode;
    if (usable && oauthMode === 'login') await continueOAuth();
  } catch (cause) {
    // Publish expiry only for an accepted read. An abandoned preload must not
    // expire a later successful session.
    if (cause instanceof ApiError && cause.status === 401)
      window.dispatchEvent(new Event('dooknow-session-expired'));
    platformError.value = '登录信息已保留，请检查连接后重试。';
  } finally {
    platformBusy.value = false;
  }
}
async function refreshPlatform() {
  await completePlatformRead();
}
async function logoutPlatform() {
  if (platformBusy.value || platformLogoutBusy.value) return;
  platformLogoutBusy.value = true;
  platformLogoutError.value = '';
  try {
    await api('/api/auth/sign-out', 'POST', {});
    completeLogout();
  } catch {
    platformLogoutError.value = '暂时无法退出，请检查连接后重试。';
  } finally {
    platformLogoutBusy.value = false;
  }
}
function completeLogout() {
  clearPluginDrafts();
  void disposePluginUIs();
  resetCsrf();
  loggedIn.value = false;
  mountedWorkspace.value = false;
  expired.value = false;
  platform.value = undefined;
  platformError.value = '';
  ownerId.value = '';
  username.value = '';
}
const scrollbarTheme = {
  scrollbarColor: 'var(--scrollbar-thumb)',
  scrollbarColorHover: 'var(--scrollbar-thumb-hover)',
  scrollbarWidth: '6px',
  scrollbarHeight: '6px',
};
const lightTheme = {
  common: {
    ...scrollbarTheme,
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
          ...scrollbarTheme,
          primaryColor: '#8ba4ff',
          primaryColorHover: '#a4b6ff',
          primaryColorPressed: '#7188e8',
          borderRadius: '6px',
        },
      }
    : lightTheme,
);
async function acceptSession(
  session: {
    user?: { id?: string; displayUsername?: string; username?: string; name?: string };
  } | null,
  preparedPlatform?: Promise<PlatformRead>,
) {
  if (typeof session?.user?.id !== 'string' || !session.user.id) {
    expired.value = true;
    return;
  }
  // The same owner keeps the mounted editor on reauthentication. A different
  // identity gets a new workspace and cannot inherit the previous draft scope.
  if (ownerId.value && ownerId.value !== session.user.id) {
    clearPluginDrafts();
    void disposePluginUIs();
    mountedWorkspace.value = false;
    platform.value = undefined;
  }
  ownerId.value = session.user.id;
  username.value =
    session.user.displayUsername || session.user.username || session.user.name || '当前账户';
  initializeEditorPreferences(ownerId.value);
  initializeAppShortcuts(ownerId.value);
  loggedIn.value = true;
  expired.value = false;
  await completePlatformRead(preparedPlatform);
}
async function login() {
  await acceptSession(await api('/api/auth/get-session'));
}
async function checkInitialSession() {
  if (sessionCheckBusy.value) return;
  sessionCheckBusy.value = true;
  try {
    const session = await api('/api/auth/get-session');
    if (session?.user) {
      const confirmedOwner = typeof session.user.id === 'string' && !!session.user.id;
      if (!oauthMode && confirmedOwner)
        void loadWorkspace().catch(() => {});
      const preparedPlatform = confirmedOwner ? readPlatform() : undefined;
      await refreshCsrf();
      await acceptSession(session, preparedPlatform);
    }
    sessionCheckError.value = '';
  } catch (error) {
    sessionCheckError.value =
      error instanceof ApiError && error.status === 401
        ? ''
        : error instanceof ApiError && error.status === 429
          ? '登录状态检查过于频繁，请稍后重试。'
          : '暂时无法连接服务，请检查连接后重试。';
  } finally {
    sessionCheckBusy.value = false;
    ready.value = true;
  }
}
function sessionExpired() {
  if (loggedIn.value) expired.value = true;
}
function protectPluginDrafts(event: BeforeUnloadEvent) {
  if (!hasUnsavedPluginDrafts()) return;
  event.preventDefault();
  event.returnValue = '';
}
onMounted(async () => {
  window.addEventListener('beforeunload', protectPluginDrafts);
  if (!token) {
    window.addEventListener('dooknow-session-expired', sessionExpired);
    await checkInitialSession();
  } else ready.value = true;
});
onBeforeUnmount(() => {
  window.removeEventListener('dooknow-session-expired', sessionExpired);
  window.removeEventListener('beforeunload', protectPluginDrafts);
  clearPluginDrafts();
  void disposePluginUIs();
});
</script>
<template>
  <AConfigProvider :locale="zhCN" :theme="activeAntTheme" :auto-insert-space-in-button="false"
    ><NConfigProvider
      :theme="resolvedTheme === 'dark' ? darkTheme : null"
      :theme-overrides="activeNaiveTheme"
      ><ShareReader v-if="token" :token="token" /><template v-else-if="ready"
        ><section
          v-if="sessionCheckError || sessionCheckBusy"
          class="share-error"
          :aria-busy="sessionCheckBusy"
        >
          <h1>暂时无法确认登录状态</h1>
          <p>{{ sessionCheckError || '正在检查登录状态…' }}</p>
          <NButton
            type="primary"
            :loading="sessionCheckBusy"
            :disabled="sessionCheckBusy"
            @click="checkInitialSession"
            >重试连接</NButton
          >
        </section>
        <OAuthConsent
          v-else-if="
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
          :service-unavailable="workspaceServiceUnavailable"
          @retry-service="refreshPlatform"
          @logout="completeLogout" /><Login v-else-if="!loggedIn" @login="login" />
        <section
          v-else-if="platformError || !platform"
          :class="platformError ? 'share-error' : undefined"
          :aria-busy="platformBusy || platformLogoutBusy"
        >
          <template v-if="platformError">
            <h1>暂时无法打开知识库</h1>
            <p>{{ platformError }}</p>
            <NAlert v-if="platformLogoutError" type="error" role="alert">{{
              platformLogoutError
            }}</NAlert>
            <NButton
              type="primary"
              :loading="platformBusy"
              :disabled="platformBusy || platformLogoutBusy"
              @click="refreshPlatform"
              >重新尝试</NButton
            >
            <NButton
              :loading="platformLogoutBusy"
              :disabled="platformBusy || platformLogoutBusy"
              @click="logoutPlatform"
              >退出并重新登录</NButton
            >
          </template>
          <LoadingState v-else variant="page" label="正在打开知识库…" />
        </section>
        <SetupWizard v-else-if="platform" :status="platform" @refresh="refreshPlatform" />
        <NModal
          :show="loggedIn && expired"
          :mask-closable="false"
          :close-on-esc="false"
          preset="card"
          class="dialog-card"
          :closable="false"
          ><Login compact @login="login" /></NModal
      ></template>
      <LoadingState v-else variant="page" label="正在打开知识空间…" /></NConfigProvider
    ></AConfigProvider
  >
</template>
