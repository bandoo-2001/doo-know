<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BlogWorkbench } from '../../blog-workbench';
import BlogDesignAppearance from './BlogDesignAppearance.vue';
import BlogDesignLinks from './BlogDesignLinks.vue';
import BlogDesignModules from './BlogDesignModules.vue';
import BlogDesignCollections from './BlogDesignCollections.vue';
import BlogDesignProjects from './BlogDesignProjects.vue';
const props = defineProps<{ model: BlogWorkbench }>();
const state = props.model.state;
const tab = ref('appearance'),
  size = ref('desktop'),
  live = ref(true);
const dirty = computed(() => props.model.designDirty());
const previewHost = ref<HTMLElement>();
const previewBounds = ref({ width: 0, height: 600 });
const viewportWidth = computed(() => (size.value === 'mobile' ? 375 : 1100));
const deviceBorder = computed(() => (size.value === 'mobile' ? 6 : 1));
const previewScale = computed(() =>
  Math.min(
    1,
    Math.max(
      1,
      (previewBounds.value.width || viewportWidth.value + deviceBorder.value * 2) -
        deviceBorder.value * 2,
    ) / viewportWidth.value,
  ),
);
const deviceStyle = computed(() => ({
  width: `${viewportWidth.value * previewScale.value + deviceBorder.value * 2}px`,
}));
const frameStyle = computed(() => ({
  width: `${viewportWidth.value}px`,
  height: `${Math.max(1, previewBounds.value.height - deviceBorder.value * 2) / previewScale.value}px`,
  transform: `scale(${previewScale.value})`,
}));
watch(
  previewHost,
  (host, _previous, onCleanup) => {
    if (!host) return;
    const measure = () => {
      previewBounds.value = { width: host.clientWidth, height: host.clientHeight };
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    measure();
    onCleanup(() => observer.disconnect());
  },
  { flush: 'post' },
);

const tabs = [
  ['appearance', '主题与个人资料'],
  ['modules', '首页模块'],
  ['collections', '专题合集'],
  ['links', '导航与链接'],
  ['projects', '项目作品'],
];
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => state.design,
  () => {
    clearTimeout(timer);
    if (live.value && state.design) timer = setTimeout(() => void props.model.previewDesign(), 450);
  },
  { deep: true },
);
watch(live, (value) => {
  if (value) void props.model.previewDesign();
});
onMounted(() => {
  if (!state.design) void props.model.loadDesign();
  else void props.model.previewDesign();
});
onBeforeUnmount(() => clearTimeout(timer));
async function upload(file: File) {
  const result = await props.model.uploadDesignMedia(file);
  return result.url;
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
</script>
<template>
  <div class="blog-studio">
    <div class="blog-section-title">
      <div>
        <span class="blog-eyebrow">MAKE IT YOURS</span>
        <h2>装修主页</h2>
        <p>给文字、作品和生活，安排一个属于你的空间。</p>
      </div>
      <span
        class="blog-badge"
        :class="{ changes: dirty || state.designState?.hasUnpublishedChanges }"
        >{{
          dirty
            ? '有未保存修改'
            : state.designState?.hasUnpublishedChanges
              ? '草稿尚未发布'
              : '与线上一致'
        }}</span
      >
    </div>
    <div v-if="state.designError" class="blog-alert error" role="alert">
      {{ state.designError
      }}<button
        type="button"
        class="blog-text-button"
        :disabled="state.designBusy || state.designLoading"
        @click="model.loadDesign()"
      >
        重新核对版本
      </button>
    </div>
    <p v-if="state.designNotice" class="blog-alert success" role="status">
      {{ state.designNotice }}
    </p>
    <p v-if="state.designLoading" role="status" class="blog-read-status">
      正在读取装修配置，当前修改会保留…
    </p>
    <div v-if="state.design" class="blog-studio-layout">
      <div class="blog-studio-editor">
        <nav class="blog-studio-tabs" aria-label="装修设置">
          <button
            v-for="[id, label] in tabs"
            :key="id"
            class="blog-text-button"
            :class="{ active: tab === id }"
            :aria-pressed="tab === id"
            @click="tab = id"
          >
            {{ label }}
          </button>
        </nav>
        <form class="blog-form" @submit.prevent="model.saveDesign()">
          <BlogDesignAppearance
            v-if="tab === 'appearance'"
            :design="state.design"
            :upload="upload"
          />
          <BlogDesignModules v-else-if="tab === 'modules'" :modules="state.design.modules" />
          <BlogDesignCollections
            v-else-if="tab === 'collections'"
            :collections="state.design.collections"
            :posts="state.dashboard?.posts || []"
          />
          <template v-else-if="tab === 'links'"
            ><BlogDesignLinks title="站点导航" :links="state.design.navigation" /><BlogDesignLinks
              title="社交链接"
              :links="state.design.socialLinks" /><BlogDesignLinks
              title="友情链接"
              :links="state.design.friendLinks"
          /></template>
          <BlogDesignProjects v-else-if="tab === 'projects'" :projects="state.design.projects" />
          <div class="blog-studio-savebar">
            <p role="status">
              {{
                state.designBusy
                  ? '正在保存更改…'
                  : dirty
                    ? '修改仅存在于当前编辑器'
                    : '装修草稿已保存'
              }}
            </p>
            <div>
              <button
                type="submit"
                class="blog-button"
                :disabled="state.designBusy || state.designLoading || !dirty"
              >
                {{ state.designBusy ? '处理中…' : '保存装修草稿' }}</button
              ><button
                type="button"
                class="blog-button primary"
                :disabled="
                  state.designBusy ||
                  state.designLoading ||
                  dirty ||
                  !state.designState?.hasUnpublishedChanges
                "
                @click="model.publishDesign()"
              >
                发布主页
              </button>
            </div>
          </div>
        </form>
        <details class="blog-studio-card blog-history">
          <summary>
            发布历史 <span class="blog-badge">{{ state.designState?.history.length || 0 }}</span>
          </summary>
          <p v-if="!state.designState?.history.length" class="blog-muted">
            首次发布后，历史版本会保存在这里。
          </p>
          <div
            v-for="revision in state.designState?.history"
            :key="revision.revision"
            class="blog-history-row"
          >
            <span
              >版本 {{ revision.revision
              }}<small>{{ new Date(revision.publishedAt).toLocaleString('zh-CN') }}</small></span
            ><button
              type="button"
              class="blog-text-button"
              :disabled="state.designBusy || dirty"
              @click="model.restoreDesign(revision.revision)"
            >
              恢复到草稿
            </button>
          </div>
        </details>
      </div>
      <aside class="blog-studio-preview" aria-label="主页实时预览">
        <div class="blog-studio-preview-heading">
          <div><strong>访客视角</strong><small>未保存的修改也能预览</small></div>
          <div class="blog-preview-devices">
            <button
              type="button"
              class="blog-text-button"
              :aria-pressed="size === 'desktop'"
              @click="size = 'desktop'"
            >
              桌面</button
            ><button
              type="button"
              class="blog-text-button"
              :aria-pressed="size === 'mobile'"
              @click="size = 'mobile'"
            >
              手机
            </button>
          </div>
        </div>
        <div class="blog-preview-options">
          <label class="blog-checkbox"><input v-model="live" type="checkbox" />实时预览</label
          ><button
            type="button"
            class="blog-text-button"
            :disabled="state.designPreviewBusy"
            @click="model.previewDesign()"
          >
            刷新预览</button
          ><span v-if="state.designPreviewBusy" role="status">正在生成…</span>
        </div>
        <p v-if="state.designPreviewError" class="blog-alert error" role="alert">
          {{ state.designPreviewError
          }}<button type="button" class="blog-text-button" @click="model.previewDesign()">
            重试预览
          </button>
        </p>
        <div ref="previewHost" class="blog-preview-host">
          <div class="blog-preview-device" :class="size" :style="deviceStyle">
            <iframe
              v-if="state.designPreviewHtml"
              :srcdoc="state.designPreviewHtml"
              :style="frameStyle"
              sandbox="allow-same-origin"
              title="博客主页草稿预览"
              referrerpolicy="no-referrer"
            />
            <div v-else class="blog-empty">
              <p>正在准备你的主页。</p>
              <button
                type="button"
                class="blog-button"
                :disabled="state.designPreviewBusy"
                @click="model.previewDesign()"
              >
                生成预览
              </button>
            </div>
          </div>
        </div>
        <p class="blog-muted">预览仅自己可见。发布主页后访客才能看到更改。</p>
      </aside>
    </div>
    <div v-else-if="!state.designLoading" class="blog-empty">
      <h3>准备你的主页装修</h3>
      <button type="button" class="blog-button" @click="model.loadDesign()">读取装修配置</button>
    </div>
  </div>
</template>
