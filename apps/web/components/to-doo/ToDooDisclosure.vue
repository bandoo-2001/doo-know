<script setup lang="ts">
import { ref, watch } from 'vue';
import { Collapse as ACollapse, CollapsePanel as ACollapsePanel } from 'ant-design-vue';
const props = defineProps<{ open?: boolean }>();
const expanded = ref(!!props.open);
watch(
  () => props.open,
  (open) => {
    expanded.value = !!open;
  },
);
</script>
<template>
  <ACollapse
    class="todo-ant-collapse"
    :active-key="expanded ? ['content'] : []"
    :bordered="false"
    @change="expanded = Array.isArray($event) ? $event.length > 0 : !!$event"
  >
    <ACollapsePanel key="content"
      ><template #header><slot name="header" /></template><slot
    /></ACollapsePanel>
  </ACollapse>
</template>
