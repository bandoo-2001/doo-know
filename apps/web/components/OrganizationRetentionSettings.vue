<script setup lang="ts">
import { ref, useId } from 'vue';
import { Alert as AAlert, Button as AButton, InputNumber as AInputNumber } from 'ant-design-vue';
import { api } from '../api';

const inputId = useId();
const retentionDays = ref<number | undefined>(30);
const loaded = ref(false), busy = ref(false), error = ref(''), notice = ref('');
const validDays = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650;

async function expand(open: boolean) {
  if (!open || loaded.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const current = await api<{ retentionDays: number }>('/api/maintenance/organization-settings');
    if (!validDays(current.retentionDays)) throw Error();
    retentionDays.value = current.retentionDays;
    loaded.value = true;
  } catch {
    error.value = '暂时无法读取保留期限，请重试。';
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (!loaded.value || busy.value) return;
  error.value = '';
  notice.value = '';
  if (!validDays(retentionDays.value)) {
    error.value = '请填写 1 至 3650 之间的整数天数。';
    return;
  }
  busy.value = true;
  try {
    const saved = await api<{ retentionDays: number }>(
      '/api/maintenance/organization-settings', 'PUT', { retentionDays: retentionDays.value },
    );
    if (!validDays(saved.retentionDays)) throw Error();
    retentionDays.value = saved.retentionDays;
    notice.value = `已保存，后续整理任务的撤销材料保留 ${saved.retentionDays} 天。`;
  } catch {
    error.value = '未能确认保存结果，请重新打开设置核对后再重试。';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <details class="retention-settings" @toggle="expand(($event.target as HTMLDetailsElement).open)">
    <summary>整理撤销材料保留期限（高级）</summary>
    <p>默认保留 30 天。更改只影响后续整理任务，不会缩短已有材料的保留期限或恢复已过期的撤销能力。</p>
    <p>未完成或需要核对的任务材料会继续保留。到期清理撤销材料，不删除笔记。</p>
    <p v-if="busy && !loaded" role="status">正在读取保留期限…</p>
    <AAlert v-if="error" type="warning" :message="error" role="alert" />
    <AButton v-if="error && !loaded" size="small" :disabled="busy" @click="expand(true)">重新读取保留期限</AButton>
    <form v-if="loaded" @submit.prevent="save">
      <label :for="inputId">整理撤销材料保留天数</label>
      <AInputNumber :value="retentionDays" @update:value="value => { retentionDays = typeof value === 'number' ? value : undefined; }" :id="inputId" :min="1" :max="3650" :precision="0" :disabled="busy" aria-label="整理撤销材料保留天数" />
      <AButton html-type="submit" :loading="busy" :disabled="busy">保存保留期限</AButton>
    </form>
    <p v-if="notice" role="status">{{ notice }}</p>
  </details>
</template>
<style scoped>
.retention-settings { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
.retention-settings summary { cursor: pointer; font-size: 13px; }
.retention-settings p { color: var(--muted); font-size: 12px; line-height: 1.7; }
.retention-settings form { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 12px; }
.retention-settings label { font-size: 13px; }
</style>
