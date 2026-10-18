<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { NButton, NInput, NAlert, NSelect } from 'naive-ui';
import type { PlatformStatus } from '../../../shared/platform-contracts';
import { api, ApiError } from '../api';
import SetupFeatures from './SetupFeatures.vue';
import SetupImport from './SetupImport.vue';
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
function zoneChanged() {
  bindRequest = crypto.randomUUID();
}
async function complete() {
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
      <span class="brand-mark" aria-hidden="true">D</span> DooKnow
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
        <form @submit.prevent="complete">
          <template v-if="mode === 'new'">
            <label for="library-name">知识库名称</label>
            <NInput
              v-model:value="name"
              :disabled="busy"
              :input-props="{ id: 'library-name', 'aria-label': '知识库名称', maxlength: 40 }"
              placeholder="例如：我的知识库"
              @update:value="changed"
            />
            <p class="hint">资料保存在部署 DooKnow 的设备上。无需手动创建文件夹。</p>
          </template>
          <div v-else class="folder-browser">
            <p class="hint">这里浏览的是部署 DooKnow 的设备，不是当前浏览器所在电脑。</p>
            <div v-if="browser" class="browser-content" :aria-busy="browserBusy">
              <div class="location">
                <span>当前位置</span><code>{{ browser.path }}</code>
              </div>
              <div class="browser-tools">
                <NButton
                  v-if="browser.parent"
                  :disabled="browserBusy || busy"
                  @click="browse(browser.parent)"
                  >返回上一级</NButton
                ><NSelect
                  v-if="browser.roots.length > 1"
                  :value="
                    browser.roots.find(
                      (r) => browser!.path === r || browser!.path.startsWith(r + '/'),
                    )
                  "
                  :options="browser.roots.map((r) => ({ label: r, value: r }))"
                  aria-label="可用位置"
                  @update:value="browse"
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
                    <span aria-hidden="true">▱</span>{{ dir.name }}<span aria-hidden="true">›</span>
                  </button>
                </li>
              </ul>
              <p v-if="!browser.directories.length" class="hint">
                没有可浏览的子文件夹，可以选择当前文件夹。
              </p>
              <p v-if="browser.truncated" class="hint">
                文件夹较多，仅显示部分结果。可以在高级设置中填写完整路径。
              </p>
              <NButton
                :disabled="busy || browserBusy || browser.roots.includes(browser.path)"
                @click="useFolder"
                >使用这个文件夹</NButton
              >
            </div>
            <p v-else class="hint">
              {{
                browserBusy ? '正在读取文件夹…' : '未能读取文件夹，请重试或在高级设置中填写路径。'
              }}
            </p>
            <NButton v-if="!browserBusy && !browser" @click="browse()">重新选择</NButton>
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
              ><NInput
                v-model:value="parentPath"
                :disabled="busy"
                :input-props="{ id: 'setup-parent', 'aria-label': '保存到哪个文件夹' }"
                placeholder="留空，使用推荐位置"
                @update:value="changed"
            /></template>
            <template v-else
              ><label for="setup-root">服务器上的知识库目录</label
              ><NInput
                v-model:value="knowledgeRoot"
                :disabled="busy"
                :input-props="{ id: 'setup-root', 'aria-label': '服务器上的知识库目录' }"
                placeholder="填写已有文件夹的完整路径"
                @update:value="changed"
            /></template>
            <p class="hint">允许保存的范围：{{ status.allowedKnowledgeBases?.join('、') }}</p>
            <label for="setup-timezone">时区</label
            ><NSelect
              v-model:value="timeZone"
              filterable
              tag
              :disabled="busy"
              :input-props="{ id: 'setup-timezone', 'aria-label': '时区' }"
              :options="timeZones"
              @update:value="zoneChanged"
            />
          </details>
          <p class="hint timezone">时间显示：{{ recommendedZone }}，可在高级设置中修改。</p>
          <footer class="setup-footer">
            <span>以后也可以继续添加和整理资料</span
            ><NButton
              attr-type="submit"
              type="primary"
              :loading="busy"
              :disabled="mode === 'new' ? !name.trim() : !knowledgeRoot.trim()"
              >确认并继续</NButton
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
            <NButton :disabled="busy" @click="go(3)">暂时跳过</NButton
            ><NButton type="primary" :disabled="busy" @click="go(3)">继续</NButton>
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
            <NButton type="primary" :loading="busy" :disabled="importBusy" @click="finish(true)"
              >创建第一篇笔记</NButton
            ><NButton :loading="busy" :disabled="importBusy" @click="finish()">进入工作区</NButton>
          </div>
          <details class="advanced">
            <summary>导入已有资料</summary>
            <SetupImport @busy="importBusy = $event" />
            <p class="hint">请保留原始资料的备份。版本记录不能代替独立备份。</p>
          </details>
          <footer class="setup-footer">
            <NButton :disabled="busy || importBusy" @click="go(2)">上一步</NButton
            ><span>所有可选功能都能稍后设置</span>
          </footer>
        </template>
      </template>
      <div v-else-if="status.phase === 'initializing'" class="preparing" role="status">
        <h1>正在准备你的知识库</h1>
        <p>正在读取资料，请稍候。已有文件会保留。</p>
        <NButton :loading="busy" @click="emit('refresh')">检查进度</NButton>
      </div>
      <template v-else-if="status.phase === 'owner_required'"
        ><h1>还差一个登录账号</h1>
        <p>请在部署设备上运行安装命令，完成账号创建后刷新此页。</p></template
      >
      <template v-else
        ><h1>暂时无法打开知识库</h1>
        <p>原有资料和设置已保留。请检查保存位置是否可用，再重试。</p>
        <NButton @click="emit('refresh')">重新检查</NButton>
        <details class="advanced">
          <summary>查看详细信息</summary>
          {{ status.code || status.phase }}
        </details></template
      >
      <NAlert v-if="error" type="error" class="setup-error" role="alert" aria-live="polite"
        >{{ error }}
        <details v-if="errorDetail">
          <summary>查看详细信息</summary>
          {{ errorDetail }}
        </details></NAlert
      >
    </section>
    <p class="setup-note">你的资料，由你掌握。</p>
  </main>
</template>
<style scoped>
.setup-page {
  max-width: 850px;
  margin: 0 auto;
  padding: 36px 22px;
  color: #243649;
}
.setup-brand {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 21px;
  font-weight: 650;
  margin-bottom: 24px;
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: #306bc7;
  color: white;
  font-size: 23px;
}
.welcome {
  font-size: 13px;
  color: #526982;
  font-weight: 400;
  margin-left: auto;
}
.setup-card {
  padding: 32px 40px;
  border: 1px solid #dbe5ee;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 12px 44px #28466808;
}
.setup-steps {
  list-style: none;
  display: flex;
  padding: 0 0 26px;
  margin: 0 0 32px;
  border-bottom: 1px solid #e8edf3;
  justify-content: space-between;
  gap: 12px;
}
.setup-steps li {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  color: #647487;
}
.setup-steps li > span {
  display: grid;
  place-items: center;
  border-radius: 50%;
  width: 25px;
  height: 25px;
  background: #f0f3f7;
}
.setup-steps .active {
  color: #245baa;
  font-weight: 600;
}
.setup-steps .active > span {
  background: #306bc7;
  color: white;
}
.setup-steps .done > span {
  background: #e8f5ee;
  color: #287553;
}
h1 {
  font-size: 28px;
  line-height: 1.3;
  margin: 8px 0 14px;
  letter-spacing: -0.5px;
}
h1:focus {
  outline: none;
}
.eyebrow {
  font-size: 13px;
  color: #59718c;
  margin: 0;
}
.intro {
  color: #52657c;
  line-height: 1.8;
  margin-bottom: 26px;
}
.mode-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 26px;
}
.mode-options button {
  border: 1px solid #dbe3ec;
  border-radius: 11px;
  padding: 18px;
  text-align: left;
  background: white;
  color: inherit;
  cursor: pointer;
}
.mode-options .selected {
  border: 2px solid #3977cf;
  padding: 17px;
  background: #f5f9ff;
}
.mode-options strong {
  display: block;
  font-size: 16px;
  margin-bottom: 8px;
}
.mode-options span {
  display: block;
  color: #52657c;
  font-size: 13px;
  line-height: 1.7;
}
label {
  display: block;
  margin: 16px 0 8px;
  font-weight: 500;
}
.hint {
  color: #576b82;
  font-size: 13px;
  line-height: 1.8;
}
.advanced {
  margin-top: 24px;
  border-top: 1px solid #e7edf4;
  padding-top: 16px;
  font-size: 14px;
}
summary {
  cursor: pointer;
  color: #435d7c;
  padding: 4px 0;
}
.timezone {
  margin-top: 20px;
}
.setup-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-top: 30px;
  border-top: 1px solid #e8edf3;
  padding-top: 22px;
}
.setup-footer > span {
  font-size: 12px;
  color: #62768c;
}
.location {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 13px;
  background: #f5f8fb;
  border-radius: 8px;
}
.location span {
  font-size: 12px;
  color: #536b82;
}
code {
  display: block;
  overflow-wrap: anywhere;
  white-space: normal;
  font-size: 13px;
}
.browser-tools {
  display: flex;
  gap: 10px;
  margin: 10px 0;
}
.folder-list {
  list-style: none;
  padding: 0;
  margin: 0 0 12px;
  max-height: 240px;
  overflow-y: auto;
}
.folder-list button {
  border: 0;
  border-bottom: 1px solid #eef2f7;
  background: white;
  color: inherit;
  width: 100%;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 13px 6px;
  cursor: pointer;
  text-align: left;
}
.folder-list button > span:last-child {
  margin-left: auto;
}
.chosen-folder {
  margin-top: 16px;
  padding: 12px;
  background: #eff8f2;
  border-radius: 8px;
}
.chosen-folder strong {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
}
.ready-mark {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #e6f4eb;
  color: #27744c;
  display: grid;
  place-items: center;
  font-size: 25px;
  margin-bottom: 20px;
}
.ready-summary {
  border-radius: 10px;
  background: #f6f9fc;
  padding: 18px;
  margin: 25px 0;
}
.ready-summary strong {
  display: block;
  margin-bottom: 10px;
}
.ready-summary p {
  font-size: 13px;
  color: #52657c;
}
.start-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.setup-error {
  margin-top: 20px;
}
.setup-error details {
  margin-top: 8px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.setup-note {
  text-align: center;
  font-size: 12px;
  color: #6c7d8e;
  margin-top: 24px;
}
button:focus-visible,
summary:focus-visible {
  outline: 3px solid #a8c8f4;
  outline-offset: 3px;
}
button:disabled {
  cursor: default;
  opacity: 0.6;
}
@media (max-width: 600px) {
  .setup-page {
    padding: 20px 12px;
  }
  .setup-card {
    padding: 24px 18px;
    border-radius: 12px;
  }
  .setup-brand {
    margin: 0 6px 20px;
  }
  .setup-steps {
    gap: 5px;
    margin-bottom: 25px;
  }
  .setup-steps li {
    font-size: 12px;
    gap: 5px;
  }
  .setup-steps li > span {
    width: 22px;
    height: 22px;
  }
  .mode-options {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .mode-options button {
    padding: 14px;
  }
  .mode-options .selected {
    padding: 13px;
  }
  h1 {
    font-size: 25px;
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
  .start-actions .n-button {
    width: 100%;
  }
}
</style>
