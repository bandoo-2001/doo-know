<script setup lang="ts" generic="K extends string">
import { reactive, useId, watch } from 'vue';

const props = defineProps<{
  label: string;
  tabs: readonly { key: K; label: string }[];
  panelClass?: string;
}>();
const active = defineModel<K>({ required: true });
const id = useId();
const visited = reactive(new Set<string>([active.value]));
watch(active, (value) => visited.add(value), { flush: 'sync' });

function selectTab(key: K) {
  active.value = key;
  document.getElementById(id + '-tab-' + key)?.focus();
}
function navigate(event: KeyboardEvent, index: number) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const count = props.tabs.length;
  let next: number;
  switch (event.key) {
    case 'ArrowRight':
      next = (index + 1) % count;
      break;
    case 'ArrowLeft':
      next = (index + count - 1) % count;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  selectTab(props.tabs[next].key);
}
</script>
<template>
  <div class="settings-tabs">
    <div class="settings-tab-bar" role="tablist" :aria-label="label">
      <button
        v-for="(tab, index) in tabs"
        :key="tab.key"
        type="button"
        role="tab"
        :id="id + '-tab-' + tab.key"
        :aria-controls="id + '-panel-' + tab.key"
        :aria-selected="tab.key === active"
        :tabindex="tab.key === active ? 0 : -1"
        @click="selectTab(tab.key)"
        @keydown="navigate($event, index)"
      >
        {{ tab.label }}
      </button>
    </div>
    <section
      v-for="tab in tabs"
      :key="tab.key"
      v-show="active === tab.key"
      role="tabpanel"
      tabindex="0"
      :id="id + '-panel-' + tab.key"
      :aria-labelledby="id + '-tab-' + tab.key"
      class="settings-tab-panel"
      :class="panelClass"
    >
      <slot v-if="visited.has(tab.key)" :tab="tab" :selectTab="selectTab" />
    </section>
  </div>
</template>
<style scoped>
.settings-tabs,
.settings-tab-panel {
  min-width: 0;
}
.settings-tab-bar {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
.settings-tab-bar button {
  min-width: 0;
  min-height: 44px;
  padding: 6px 14px;
  font: inherit;
  font-size: 14px;
  color: var(--muted);
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.settings-tab-bar button[aria-selected='true'] {
  color: var(--blue);
  border-bottom-color: currentColor;
  font-weight: 600;
}
.settings-tab-bar button:hover {
  background: var(--surface-soft);
}
.settings-tab-bar button:focus-visible,
.settings-tab-panel:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
@media (max-width: 600px) {
  .settings-tab-bar {
    gap: 0;
  }
  .settings-tab-bar button {
    flex: 1 1 0;
    padding-inline: 2px;
    font-size: 13px;
  }
}
</style>
