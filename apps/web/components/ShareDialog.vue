<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NModal } from 'naive-ui';
import { Alert as AAlert, Button as AButton, Input as AInput } from 'ant-design-vue';
import type { ShareOptions, ShareStatus } from '../../../shared/share-contracts';
import Icon from './Icon.vue';
const props = defineProps<{
  show: boolean;
  title: string;
  status: ShareStatus;
  busy: boolean;
  error?: string;
}>();
const emit = defineEmits<{
  'update:show': [show: boolean];
  action: [action: 'create' | 'reset' | 'revoke', options?: ShareOptions];
}>();
const permission = ref<'view' | 'edit'>('view');
const duration = ref('7d'),
  customDate = ref(''),
  validation = ref(''),
  copied = ref(false),
  copyError = ref('');
let originalDate = '',
  originalExpiry: string | null = null;
const shareUrl = computed(() =>
  props.status.url ? new URL(props.status.url, location.origin).href : '',
);
const badge = computed(
  () =>
    ({ private: '私人笔记', active: '分享已开启', expired: '分享已到期', revoked: '分享已取消' })[
      props.status.state
    ],
);
function localDate(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
watch(
  [() => props.show, () => props.status],
  () => {
    if (!props.show) return;
    permission.value = props.status.permission;
    originalExpiry = props.status.expiresAt;
    duration.value =
      props.status.state === 'private' ? '7d' : originalExpiry ? 'custom' : 'permanent';
    customDate.value = originalExpiry ? localDate(originalExpiry) : '';
    originalDate = customDate.value;
    validation.value = '';
    copied.value = false;
    copyError.value = '';
  },
  { immediate: true },
);
function submit(action: 'create' | 'reset' | 'revoke') {
  validation.value = '';
  if (action === 'revoke') {
    emit('action', action);
    return;
  }
  let expiresAt: string | null = null;
  if (duration.value === 'custom') {
    const effectiveExpiry =
      customDate.value === originalDate && originalExpiry ? originalExpiry : customDate.value;
    const date = new Date(effectiveExpiry);
    if (!customDate.value || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
      validation.value = '请选择未来的到期时间。';
      return;
    }
    expiresAt = date.toISOString();
  } else if (duration.value !== 'permanent') {
    const milliseconds: Record<string, number> = {
      '1h': 3600000,
      '1d': 86400000,
      '7d': 604800000,
      '30d': 2592000000,
    };
    expiresAt = new Date(Date.now() + milliseconds[duration.value]).toISOString();
  }
  emit('action', action, { permission: permission.value, expiresAt });
}
async function copy() {
  copied.value = false;
  copyError.value = '';
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    copied.value = true;
  } catch {
    copyError.value = '复制失败，请选中公开链接手动复制。';
  }
}
</script>
<template>
  <NModal
    :show="show"
    @update:show="emit('update:show', $event)"
    preset="card"
    class="dialog-card share-dialog"
    title="分享笔记"
  >
    <AAlert
      v-if="error || validation || copyError"
      type="error"
      :message="error || validation || copyError"
      role="alert"
    />
    <h3 class="share-title">
      {{ title }}<span class="share-badge">{{ badge }}</span>
    </h3>
    <template v-if="status.enabled && shareUrl">
      <label>公开链接</label>
      <div class="share-link">
        <AInput :value="shareUrl" readonly aria-label="公开链接" />
        <AButton type="primary" @click="copy"
          ><template #icon><Icon :name="copied ? 'check' : 'copy'" :size="15" /></template
          >{{ copied ? '已复制' : '复制链接' }}</AButton
        >
      </div>
      <p class="muted">
        持有链接的人无需登录，即可{{
          status.permission === 'edit' ? '查看和编辑' : '查看'
        }}这篇笔记。
      </p>
    </template>
    <p v-else class="muted">
      {{
        status.state === 'expired'
          ? '链接已到期，访客无法访问。生成链接可重新开启分享。'
          : '笔记默认私有。生成链接后，持有链接的访客无需登录即可访问。'
      }}
    </p>
    <div class="share-settings">
      <label
        >分享权限<select v-model="permission" aria-label="分享权限" :disabled="busy">
          <option value="view">仅查看</option>
          <option value="edit" :disabled="!status.editSupported">允许编辑</option>
        </select></label
      >
      <label
        >链接有效期<select v-model="duration" aria-label="链接有效期" :disabled="busy">
          <option value="1h">1 小时</option>
          <option value="1d">1 天</option>
          <option value="7d">7 天</option>
          <option value="30d">30 天</option>
          <option value="custom">自定义时间</option>
          <option value="permanent">永久有效</option>
        </select></label
      >
      <label v-if="duration === 'custom'" class="share-custom"
        >自定义到期时间<input
          v-model="customDate"
          aria-label="自定义到期时间"
          type="datetime-local"
          :disabled="busy"
        /><small>按当前设备的本地时间设置。</small></label
      >
    </div>
    <p v-if="!status.editSupported" class="share-limitation" role="note">
      {{
        status.editUnavailableReason ||
        '仅普通 Markdown 笔记支持公开编辑；大文件和白板目前仅支持查看。'
      }}
    </p>
    <p v-if="permission === 'edit'" class="share-limitation">
      访客可修改并手动保存这篇笔记；不支持上传附件，也不能通过此链接编辑引用的白板。
    </p>
    <div class="share-info">
      <Icon name="refresh" :size="27" />
      <div>
        <b>实时更新</b>
        <p>展示最新保存内容，未保存的修改不会公开。</p>
      </div>
    </div>
    <div class="dialog-actions share-actions">
      <template v-if="status.enabled"
        ><AButton :disabled="busy" @click="submit('reset')">重置链接</AButton
        ><AButton danger type="text" :disabled="busy" @click="submit('revoke')"
          >取消分享</AButton
        ></template
      >
      <AButton type="primary" :loading="busy" :disabled="busy" @click="submit('create')">{{
        status.enabled ? '保存分享设置' : '生成分享链接'
      }}</AButton>
      <AButton :disabled="busy" @click="emit('update:show', false)">完成</AButton>
    </div>
  </NModal>
</template>
<style scoped>
.share-title {
  overflow-wrap: anywhere;
  line-height: 1.8;
}
.share-settings {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 22px;
}
.share-settings label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  color: var(--text);
  font-size: 12px;
}
.share-settings select,
.share-settings input {
  width: 100%;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--text);
  font: inherit;
}
.share-settings select:focus-visible,
.share-settings input:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
.share-custom {
  grid-column: 1/-1;
}
.share-custom small,
.share-limitation {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
.share-link :deep(.ant-input) {
  min-width: 0;
}
.share-link :deep(.ant-btn) {
  flex-shrink: 0;
}
.share-actions {
  flex-wrap: wrap;
}
@media (max-width: 540px) {
  .share-settings {
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
  }
  .share-actions :deep(.ant-btn) {
    flex: 1 1 auto;
  }
  .share-title .share-badge {
    display: inline-block;
  }
}
</style>
