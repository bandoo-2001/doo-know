<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import {
  Button as AButton,
  Input as AInput,
  Alert as AAlert,
  Select as ASelect,
  AutoComplete as AAutoComplete,
} from 'ant-design-vue';
import type { PlatformStatus } from '../../../shared/platform-contracts';
import { api, ApiError } from '../api';
import SetupFeatures from './SetupFeatures.vue';
import SetupImport from './SetupImport.vue';
import Icon from './Icon.vue';
const props = defineProps<{ status: PlatformStatus }>();
const emit = defineEmits<{ refresh: [] }>();
const mode = ref<'new' | 'existing'>('new'),
  name = ref('我的知识库'),
  knowledgeRoot = ref('');
const timeZone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');
const error = ref(''),
  busy = ref(false),
  browserBusy = ref(false),
  errorDetail = ref('');
const heading = ref<HTMLElement>(),
  step = ref(props.status.phase === 'ready' ? 2 : 1);
const browser = ref<{
  path: string;
  parent: string | null;
  roots: string[];
  suggestedParent: string;
  directories: { name: string; path: string }[];
  truncated: boolean;
}>();
const parentPath = ref(''),
  importBusy = ref(false);
let createRequest = crypto.randomUUID(),
  bindRequest = crypto.randomUUID(),
  createdPath = '';
const timeZones = [
  ...new Set([
    timeZone.value,
    'Asia/Shanghai',
    'Asia/Hong_Kong',
    'Asia/Taipei',
    'Asia/Tokyo',
    'Asia/Singapore',
    'UTC',
    'Europe/London',
    'America/New_York',
    'America/Los_Angeles',
  ]),
].map((value) => ({
  value,
  label:
    value === 'Asia/Shanghai'
      ? '中国标准时间（UTC+8）'
      : value === 'UTC'
        ? '协调世界时（UTC）'
        : value.replaceAll('_', ' '),
}));
const recommendedZone = computed(
  () => timeZones.find((t) => t.value === timeZone.value)?.label || timeZone.value,
);
const messages: Record<string, string> = {
  FORBIDDEN_KNOWLEDGE_ROOT: '这个位置不能用于保存资料，请换一个保存位置。',
  INVALID_KNOWLEDGE_ROOT: '无法使用这个文件夹。请选择已存在、可读写的文件夹，不能选择快捷链接。',
  DIRECTORY_NOT_WRITABLE: '无法在这个位置保存文件，请换一个保存位置。',
  DIRECTORY_EXISTS: '这个名称的文件夹已经存在。请换个名称，或选择“使用已有资料”。',
  INVALID_LIBRARY_NAME: '请填写简短的知识库名称，不要包含斜杠，也不要以点开头。',
  KNOWLEDGE_ROOT_CHANGED: '这个文件夹刚刚发生了变化，请重新选择后继续。',
  VALIDATION_EXPIRED: '确认时间已过，请再次点击“确认并继续”。',
  INVALID_TIME_ZONE: '这个时区无法使用，请在高级设置中重新选择。',
  SETUP_ALREADY_COMPLETE: '知识库已设置，请刷新页面继续。',
};
function describe(e: unknown) {
  errorDetail.value = e instanceof Error ? e.message : String(e);
  if (e instanceof ApiError && e.status === 401) return '登录已过期，请重新登录后继续。';
  return (
    (e instanceof ApiError && messages[String(e.data.code)]) ||
    '暂时没能完成，请检查连接后重试。你的资料不会被清空。'
  );
}
function changed() {
  createdPath = '';
  createRequest = crypto.randomUUID();
  bindRequest = crypto.randomUUID();
  error.value = '';
}
async function browse(path?: string) {
  browserBusy.value = true;
  error.value = '';
  try {
    browser.value = await api('/api/platform/setup/directories', 'POST', path ? { path } : {});
  } catch (e) {
    error.value = describe(e);
  } finally {
    browserBusy.value = false;
  }
}
async function selectMode(value: 'new' | 'existing') {
  mode.value = value;
  error.value = '';
  if (value === 'existing' && !browser.value) await browse();
}
function useFolder() {
  knowledgeRoot.value = browser.value!.path;
  changed();
}
function filterTimeZone(input: string, option?: { label?: unknown; value?: unknown }) {
  return String(option?.label || option?.value)
    .toLowerCase()
    .includes(input.toLowerCase());
}
function zoneChanged() {
  bindRequest = crypto.randomUUID();
}
async function complete() {
  if (busy.value || (mode.value === 'new' ? !name.value.trim() : !knowledgeRoot.value.trim()))
    return;
  busy.value = true;
  error.value = '';
  try {
    if (mode.value === 'new') {
      if (!createdPath) {
        const made = await api<{ knowledgeRoot: string }>('/api/platform/setup/create', 'POST', {
          name: name.value.trim(),
          ...(parentPath.value.trim() ? { parentPath: parentPath.value.trim() } : {}),
          requestId: createRequest,
        });
        createdPath = made.knowledgeRoot;
      }
      knowledgeRoot.value = createdPath;
    }
    const proof = await api<{ knowledgeRoot: string; validationId: string }>(
      '/api/platform/setup/validate',
      'POST',
      { knowledgeRoot: knowledgeRoot.value.trim() },
    );
    await api('/api/platform/setup/complete', 'POST', {
      ...proof,
      timeZone: timeZone.value,
      requestId: bindRequest,
    });
    emit('refresh');
  } catch (e) {
    error.value = describe(e);
  } finally {
    busy.value = false;
  }
}
async function go(value: number) {
  step.value = value;
  error.value = '';
  await nextTick();
  heading.value?.focus();
}
async function finish(createNote = false) {
  if (busy.value || importBusy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api('/api/platform/setup/finish', 'POST', {});
    if (createNote) {
      try {
        sessionStorage.setItem('dooknow-welcome-action', 'create-note');
      } catch {
        /* Opening the workspace remains possible with browser storage disabled. */
      }
    }
    emit('refresh');
  } catch (e) {
    error.value = describe(e);
  } finally {
    busy.value = false;
  }
}
watch(
  () => props.status.phase,
  (phase) => {
    if (phase === 'ready') void go(2);
  },
);
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  timer = setInterval(() => {
    if (props.status.phase === 'initializing') emit('refresh');
  }, 1500);
});
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <main class="setup-page" :aria-busy="busy">
    <header class="setup-brand">
      <Icon name="book" :size="29" /> DooKnow
      <span class="welcome">欢迎使用</span>
    </header>
    <section class="setup-card">
      <ol class="setup-steps" aria-label="首次设置进度">
        <li
          v-for="(label, i) in ['准备知识库', '选择功能', '开始使用']"
          :key="label"
          :class="{ active: step === i + 1, done: step > i + 1 }"
          :aria-current="step === i + 1 ? 'step' : undefined"
        >
          <span>{{ step > i + 1 ? '✓' : i + 1 }}</span
          >{{ label }}
        </li>
      </ol>
      <template v-if="status.phase === 'setup_required'">
        <p class="eyebrow">让资料有个自己的家</p>
        <h1 ref="heading" tabindex="-1">准备你的知识库</h1>
        <p class="intro">从一个新空间开始，或接入你已经整理好的资料。</p>
        <form @submit.prevent="complete">
          <p class="field-title">资料来源</p>
          <div class="mode-options" aria-label="知识库来源">
            <button
              type="button"
              aria-label="创建新知识库"
              :class="{ selected: mode === 'new' }"
              :aria-pressed="mode === 'new'"
              :disabled="busy"
              @click="selectMode('new')"
            >
              <strong>创建新知识库</strong><span>只需起个名字，保存位置由我们准备。</span>
            </button>
            <button
              type="button"
              aria-label="使用已有资料"
              :class="{ selected: mode === 'existing' }"
              :aria-pressed="mode === 'existing'"
              :disabled="busy"
              @click="selectMode('existing')"
            >
              <strong>使用已有资料</strong><span>选择部署设备上的文件夹，保留原有文件。</span>
            </button>
          </div>
          <div v-if="mode === 'new'" class="library-name-field">
            <label for="library-name">知识库名称</label>
            <AInput
              :value="name"
              :disabled="busy"
              id="library-name"
              aria-label="知识库名称"
              :maxlength="40"
              required
              placeholder="例如：我的知识库"
              @update:value="
                (value) => {
                  name = String(value ?? '');
                  changed();
                }
              "
            />
            <p class="hint">资料保存在部署 DooKnow 的设备上。无需手动创建文件夹。</p>
          </div>
          <div v-if="mode === 'existing'" class="folder-browser">
            <p class="hint">这里浏览的是部署 DooKnow 的设备，不是当前浏览器所在电脑。</p>
            <div v-if="browser" class="browser-content" :aria-busy="browserBusy">
              <div class="location">
                <span>当前位置</span><code>{{ browser.path }}</code>
              </div>
              <div class="browser-tools">
                <AButton
                  v-if="browser.parent"
                  :disabled="browserBusy || busy"
                  @click="browse(browser.parent)"
                  >返回上一级</AButton
                ><ASelect
                  v-if="browser.roots.length > 1"
                  :disabled="browserBusy || busy"
                  :value="
                    browser.roots.find(
                      (r) => browser!.path === r || browser!.path.startsWith(r + '/'),
                    )
                  "
                  :options="browser.roots.map((r) => ({ label: r, value: r }))"
                  aria-label="可用位置"
                  @change="(value) => browse(String(value))"
                />
              </div>
              <ul class="folder-list" aria-label="可选文件夹">
                <li v-for="dir in browser.directories" :key="dir.path">
                  <button
                    type="button"
                    :disabled="browserBusy || busy"
                    :aria-label="'打开文件夹 ' + dir.name"
                    @click="browse(dir.path)"
                  >
                    <Icon name="folder" :size="18" /><span class="folder-name">{{ dir.name }}</span
                    ><Icon name="chevron" :size="15" />
                  </button>
                </li>
              </ul>
              <p v-if="!browser.directories.length" class="hint">
                没有可浏览的子文件夹，可以选择当前文件夹。
              </p>
              <p v-if="browser.truncated" class="hint">
                文件夹较多，仅显示部分结果。可以在高级设置中填写完整路径。
              </p>
              <AButton
                :disabled="busy || browserBusy || browser.roots.includes(browser.path)"
                @click="useFolder"
                >使用这个文件夹</AButton
              >
            </div>
            <p v-else class="hint">
              {{
                browserBusy ? '正在读取文件夹…' : '未能读取文件夹，请重试或在高级设置中填写路径。'
              }}
            </p>
            <AButton v-if="!browserBusy && !browser" @click="browse()">重新选择</AButton>
            <div v-if="knowledgeRoot" class="chosen-folder" role="status">
              <strong>已选择</strong><code>{{ knowledgeRoot }}</code>
            </div>
            <p class="hint">已有文件会保留，不会清空这个文件夹。</p>
          </div>
          <details class="advanced">
            <summary>高级设置</summary>
            <p class="hint">需要自定义保存位置或时区时再修改。</p>
            <template v-if="mode === 'new'"
              ><label for="setup-parent">保存到哪个文件夹</label
              ><AInput
                :value="parentPath"
                :disabled="busy"
                id="setup-parent"
                aria-label="保存到哪个文件夹"
                placeholder="留空，使用推荐位置"
                @update:value="
                  (value) => {
                    parentPath = String(value ?? '');
                    changed();
                  }
                "
            /></template>
            <template v-else
              ><label for="setup-root">服务器上的知识库目录</label
              ><AInput
                :value="knowledgeRoot"
                :disabled="busy"
                id="setup-root"
                aria-label="服务器上的知识库目录"
                placeholder="填写已有文件夹的完整路径"
                @update:value="
                  (value) => {
                    knowledgeRoot = String(value ?? '');
                    changed();
                  }
                "
            /></template>
            <p class="hint">允许保存的范围：{{ status.allowedKnowledgeBases?.join('、') }}</p>
            <label for="setup-timezone">时区</label
            ><AAutoComplete
              :value="timeZone"
              :filter-option="filterTimeZone"
              :disabled="busy"
              id="setup-timezone"
              :options="timeZones"
              @update:value="
                (value) => {
                  timeZone = String(value ?? '');
                  zoneChanged();
                }
              "
            />
          </details>
          <p class="hint timezone">时间显示：{{ recommendedZone }}，可在高级设置中修改。</p>
          <footer class="setup-footer">
            <span>以后也可以继续添加和整理资料</span
            ><AButton
              html-type="submit"
              type="primary"
              :loading="busy"
              :disabled="busy || (mode === 'new' ? !name.trim() : !knowledgeRoot.trim())"
              >确认并继续</AButton
            >
          </footer>
        </form>
      </template>
      <template v-else-if="status.phase === 'ready'">
        <template v-if="step === 2">
          <p class="eyebrow">按自己的需要选择</p>
          <h1 ref="heading" tabindex="-1">选择需要的功能</h1>
          <p class="intro">知识库已经可以使用。这些功能都可以跳过，以后在设置中添加。</p>
          <SetupFeatures />
          <footer class="setup-footer">
            <AButton :disabled="busy" @click="go(3)">暂时跳过</AButton
            ><AButton type="primary" :disabled="busy" @click="go(3)">继续</AButton>
          </footer>
        </template>
        <template v-else>
          <div class="ready-mark" aria-hidden="true">✓</div>
          <h1 ref="heading" tabindex="-1">知识库准备好了</h1>
          <p class="intro">写下第一个想法，或把已有资料放进来。之后的设置都能在工作区里找到。</p>
          <div class="ready-summary">
            <strong>资料保存位置</strong><code>{{ status.knowledgeRoot }}</code>
            <p>资料保存在部署 DooKnow 的设备上。</p>
          </div>
          <div class="start-actions">
            <AButton
              type="primary"
              :loading="busy"
              :disabled="busy || importBusy"
              @click="finish(true)"
              >创建第一篇笔记</AButton
            ><AButton :loading="busy" :disabled="busy || importBusy" @click="finish()"
              >进入工作区</AButton
            >
          </div>
          <details class="advanced">
            <summary>导入已有资料</summary>
            <SetupImport @busy="importBusy = $event" />
            <p class="hint">请保留原始资料的备份。版本记录不能代替独立备份。</p>
          </details>
          <footer class="setup-footer">
            <AButton :disabled="busy || importBusy" @click="go(2)">上一步</AButton
            ><span>所有可选功能都能稍后设置</span>
          </footer>
        </template>
      </template>
      <div v-else-if="status.phase === 'initializing'" class="preparing" role="status">
        <h1>正在准备你的知识库</h1>
        <p>正在读取资料，请稍候。已有文件会保留。</p>
        <AButton :loading="busy" @click="emit('refresh')">检查进度</AButton>
      </div>
      <div v-else-if="status.phase === 'owner_required'" class="setup-state">
        <h1>还差一个登录账号</h1>
        <p>请在部署设备上运行安装命令，完成账号创建后刷新此页。</p>
      </div>
      <div v-else class="setup-state">
        <h1>暂时无法打开知识库</h1>
        <p>原有资料和设置已保留。请检查保存位置是否可用，再重试。</p>
        <AButton @click="emit('refresh')">重新检查</AButton>
        <details class="advanced">
          <summary>查看详细信息</summary>
          {{ status.code || status.phase }}
        </details>
      </div>
      <AAlert
        v-if="error"
        type="error"
        show-icon
        :message="error"
        class="setup-error"
        role="alert"
        aria-live="polite"
      >
        <template v-if="errorDetail" #description>
          <details>
            <summary>查看详细信息</summary>
            {{ errorDetail }}
          </details>
        </template>
      </AAlert>
    </section>
    <p class="setup-note">你的资料，由你掌握。</p>
  </main>
</template>
<style scoped>
.setup-page {
  max-width: 840px;
  margin: 0 auto;
  padding: 36px 24px 24px;
  color: var(--text, #262b36);
}
.setup-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 24px;
  color: var(--blue, #4566c6);
  font-size: 23px;
  font-weight: 650;
  letter-spacing: -0.5px;
}
.welcome {
  margin-left: auto;
  color: var(--muted, #7a8190);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0;
}
.setup-card {
  min-width: 0;
  padding: 28px 32px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 10px;
  background: white;
}
.setup-steps {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 24px;
  padding: 0 0 24px;
  border-bottom: 1px solid var(--border, #e3e6ec);
  list-style: none;
}
.setup-steps li {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--muted, #7a8190);
  font-size: 12px;
}
.setup-steps li > span {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 50%;
  background: var(--surface-soft, #fafbfc);
  font-size: 11px;
}
.setup-steps .active {
  color: var(--blue, #4566c6);
  font-weight: 600;
}
.setup-steps .active > span {
  border-color: var(--blue, #4566c6);
  background: var(--blue, #4566c6);
  color: white;
}
.setup-steps .done > span {
  border-color: #dce3f6;
  background: #eef1fa;
  color: var(--blue, #4566c6);
}
h1 {
  margin: 8px 0 12px;
  color: var(--text, #262b36);
  font-size: 26px;
  font-weight: 650;
  line-height: 1.45;
  letter-spacing: -0.6px;
}
h1:focus {
  outline: none;
}
.eyebrow {
  margin: 0;
  color: var(--muted, #7a8190);
  font-size: 12px;
}
.intro,
.setup-state > p,
.preparing > p {
  margin: 0 0 24px;
  color: #6c7482;
  font-size: 14px;
  line-height: 1.7;
}
.library-name-field {
  margin-bottom: 24px;
}
.library-name-field label {
  margin-top: 0;
}
.library-name-field :deep(.ant-input) {
  min-height: 40px;
}
.advanced :deep(.ant-select) {
  width: 100%;
}
.field-title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 500;
}
.mode-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.mode-options button {
  position: relative;
  padding: 18px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
  background: white;
  color: inherit;
  text-align: left;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.mode-options button:hover {
  border-color: #bfc9e7;
  background: var(--surface-soft, #fafbfc);
}
.mode-options .selected {
  border-color: var(--blue, #4566c6);
  background: #f5f7fd;
}
.mode-options strong {
  display: block;
  margin-bottom: 7px;
  font-size: 14px;
  font-weight: 600;
}
.mode-options .selected strong {
  color: var(--blue, #4566c6);
}
.mode-options span {
  display: block;
  color: #6c7482;
  font-size: 12px;
  line-height: 1.8;
}
label {
  display: block;
  margin: 17px 0 8px;
  font-size: 13px;
  font-weight: 500;
}
.hint {
  color: var(--muted, #7a8190);
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.advanced {
  margin-top: 22px;
  padding-top: 14px;
  border-top: 1px solid var(--border, #e3e6ec);
  font-size: 13px;
}
summary {
  width: fit-content;
  padding: 4px 0;
  color: #596271;
  cursor: pointer;
}
.advanced[open] > summary {
  margin-bottom: 12px;
  color: var(--text, #262b36);
}
.timezone {
  margin-top: 18px;
}
.setup-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  margin-top: 26px;
  padding-top: 20px;
  border-top: 1px solid var(--border, #e3e6ec);
}
.setup-footer > span {
  color: var(--muted, #7a8190);
  font-size: 12px;
  line-height: 1.8;
}
.folder-browser {
  min-width: 0;
}
.browser-content {
  padding: 14px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
}
.location {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid #edf0f4;
  border-radius: 5px;
  background: var(--surface-soft, #fafbfc);
}
.location span {
  color: var(--muted, #7a8190);
  font-size: 11px;
}
code {
  display: block;
  color: #545e6d;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
  white-space: normal;
}
.browser-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
}
.browser-tools .ant-select {
  min-width: 0;
  flex: 1 1 160px;
}
.folder-list {
  max-height: 250px;
  margin: 0 0 12px;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.folder-list button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 10px 8px;
  border: 0;
  border-bottom: 1px solid #edf0f4;
  border-radius: 4px;
  background: white;
  color: inherit;
  font-size: 13px;
  text-align: left;
}
.folder-list button:hover {
  background: var(--surface-soft, #fafbfc);
}
.folder-list svg {
  flex-shrink: 0;
  color: var(--muted, #7a8190);
}
.folder-list svg:last-child {
  margin-left: auto;
}
.folder-name {
  min-width: 0;
  overflow-wrap: anywhere;
}
.chosen-folder {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid #dce3f6;
  border-radius: 6px;
  background: #f5f7fd;
}
.chosen-folder strong {
  display: block;
  margin-bottom: 4px;
  color: var(--blue, #4566c6);
  font-size: 12px;
  font-weight: 500;
}
.ready-mark {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  margin-bottom: 20px;
  border: 1px solid #dce3f6;
  border-radius: 10px;
  background: #eef1fa;
  color: var(--blue, #4566c6);
  font-size: 22px;
}
.ready-summary {
  margin: 24px 0;
  padding: 18px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 7px;
  background: var(--surface-soft, #fafbfc);
}
.ready-summary strong {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 500;
}
.ready-summary p {
  margin: 8px 0 0;
  color: var(--muted, #7a8190);
  font-size: 12px;
  line-height: 1.8;
}
.start-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.setup-state,
.preparing {
  padding: 8px 0 18px;
}
.setup-error {
  margin-top: 20px;
  overflow-wrap: anywhere;
}
.setup-error details {
  margin-top: 8px;
  font-size: 12px;
}
.setup-note {
  margin-top: 22px;
  color: var(--muted, #7a8190);
  font-size: 11px;
  text-align: center;
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--focus, #4566c6);
  outline-offset: 3px;
}
button:disabled {
  cursor: default;
  opacity: 0.6;
}
@media (max-width: 600px) {
  .setup-page {
    padding: 22px 14px 16px;
  }
  .setup-brand {
    margin: 0 4px 20px;
    font-size: 21px;
  }
  .setup-card {
    padding: 22px 18px;
    border-radius: 8px;
  }
  .setup-steps {
    gap: 5px;
    margin-bottom: 24px;
    padding-bottom: 20px;
  }
  .setup-steps li {
    gap: 5px;
    font-size: 11px;
  }
  .setup-steps li > span {
    width: 20px;
    height: 20px;
    font-size: 10px;
  }
  h1 {
    font-size: 23px;
  }
  .intro {
    font-size: 13px;
  }
  .mode-options {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
  .mode-options button {
    padding: 15px;
  }
  .setup-footer {
    flex-wrap: wrap;
  }
  .setup-footer > span {
    flex: 1 1 150px;
  }
  .start-actions {
    flex-direction: column;
  }
  .start-actions .ant-btn {
    width: 100%;
  }
  .browser-content {
    padding: 10px;
  }
}
</style>
