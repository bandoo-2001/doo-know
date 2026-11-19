<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Alert as AAlert, Button as AButton, Input as AInput } from 'ant-design-vue';
import type { ToDooRequest } from '../../to-doo-workbench';
import { useToDooConfirm } from '../../to-doo-controls';

const props = defineProps<{ request: ToDooRequest }>();
const confirm = useToDooConfirm();
const endpoint = '/api/to-doo/watch/devices';
const devices = ref<{ id: string; createdAt: string }[]>([]);
const userCode = ref('');
const normalizedCode = computed(() => userCode.value.toUpperCase().replace(/[\s-]/g, ''));
const validCode = computed(() => /^[A-HJ-NP-Z2-9]{8}$/.test(normalizedCode.value));
const busy = ref(false);
const error = ref('');
const notice = ref('');

async function refresh() {
  const result = await props.request(endpoint);
  devices.value = result.devices;
}

async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await action();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '请求失败，请重试';
  } finally {
    busy.value = false;
  }
}

function approve() {
  if (!validCode.value) return;
  const code = normalizedCode.value;
  void run(async () => {
    await props.request(endpoint + '/approve', 'POST', { userCode: code });
    userCode.value = '';
    notice.value = '已授权，请回到手表完成连接。';
    await refresh();
  });
}

async function revoke(id: string) {
  if (
    !(await confirm('解除后，这块手表需要重新配对才能访问 To Doo。', {
      title: '解除手表配对',
      danger: true,
    }))
  )
    return;
  await run(async () => {
    await props.request(endpoint + '/' + encodeURIComponent(id), 'DELETE');
    notice.value = '已解除手表配对。';
    await refresh();
  });
}

onMounted(() => run(refresh));
</script>

<template>
  <section class="todo-panel" aria-label="手表配对">
    <div class="todo-panel-header">
      <h2>手表配对</h2>
      <AButton type="link" :disabled="busy" @click="run(refresh)">刷新手表列表</AButton>
    </div>
    <form class="todo-pad todo-form" @submit.prevent="approve">
      <p>打开手表上的 To Doo，在这里输入表上显示的 8 位配对码。</p>
      <label
        >手表配对码<AInput
          v-model:value="userCode"
          autocomplete="one-time-code"
          autocapitalize="characters"
          :maxlength="16"
          :disabled="busy"
          required
      /></label>
      <div class="todo-actions">
        <AButton type="primary" html-type="submit" :disabled="busy || !validCode"
          >授权手表</AButton
        >
      </div>
      <AAlert v-if="error" type="error" :message="error" show-icon role="alert" />
      <p v-if="notice" role="status">{{ notice }}</p>
    </form>
    <div v-for="device in devices" :key="device.id" class="todo-setting-row">
      <div>
        <h3>小米手表 · {{ device.id.slice(-6) }}</h3>
        <p>授权于 {{ new Date(device.createdAt).toLocaleString() }}</p>
      </div>
      <AButton type="link" danger :disabled="busy" @click="revoke(device.id)">解除配对</AButton>
    </div>
  </section>
</template>
