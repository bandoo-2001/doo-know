<script setup lang="ts">
import { Button as AButton } from 'ant-design-vue';
import Icon from '../Icon.vue';
withDefaults(
  defineProps<{ title: string; description: string; icon?: string; actionLabel?: string }>(),
  { actionLabel: '管理' },
);
const emit = defineEmits<{ open: [] }>();
</script>
<template>
  <section
    class="settings-card settings-action-card"
    :class="{ 'settings-action-card-with-icon': icon }"
  >
    <span v-if="icon" class="settings-action-icon"><Icon :name="icon" :size="21" /></span>
    <div class="settings-action-copy">
      <h2>{{ title }}</h2>
      <p class="settings-muted">{{ description }}</p>
      <slot />
    </div>
    <AButton class="settings-action-button" @click="emit('open')"
      >{{ actionLabel }}<Icon name="chevron" :size="13"
    /></AButton>
  </section>
</template>
