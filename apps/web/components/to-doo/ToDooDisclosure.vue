<script setup lang="ts">
import { ref, watch } from 'vue';
import { Collapse as ACollapse, CollapsePanel as ACollapsePanel } from 'ant-design-vue';
const props = defineProps<{ open?: boolean }>();
const expanded = ref(!!props.open);
const immediate = ref(false);
watch(
  () => props.open,
  (open) => {
    immediate.value = false;
    expanded.value = !!open;
  },
);
defineExpose({
  expand: (options?: { immediate?: boolean }) => {
    immediate.value = !!options?.immediate;
    expanded.value = true;
  },
});
</script>
<template>
  <ACollapse
    class="todo-ant-collapse"
    :active-key="expanded ? ['content'] : []"
    :bordered="false"
    :open-animation="immediate ? { css: false } : undefined"
    @change="
      immediate = false;
      expanded = Array.isArray($event) ? $event.length > 0 : !!$event;
    "
  >
    <ACollapsePanel key="content"
      ><template #header><slot name="header" /></template><slot
    /></ACollapsePanel>
  </ACollapse>
</template>
