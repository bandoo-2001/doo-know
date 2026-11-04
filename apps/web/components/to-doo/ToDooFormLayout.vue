<script setup lang="ts">
import { computed, ref } from 'vue';
import { Form as AForm } from 'ant-design-vue';
import { useMutationObserver } from '@vueuse/core';

defineProps<{ busy?: boolean }>();
const emit = defineEmits<{
  submit: [event: Event];
  invalid: [event: Event];
  'validity-change': [invalid: boolean];
}>();
const form = ref<InstanceType<typeof AForm>>();
const element = computed<HTMLFormElement | undefined>(() => form.value?.$el);
const hasInvalidInput = () => !!element.value?.querySelector('[aria-invalid="true"]');
useMutationObserver(element, () => emit('validity-change', hasInvalidInput()), {
  subtree: true,
  attributes: true,
  attributeFilter: ['aria-invalid'],
});
function submit(event: Event) {
  const invalid = element.value?.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (invalid) {
    invalid.dispatchEvent(new Event('invalid', { cancelable: true }));
    return;
  }
  emit('submit', event);
}
defineExpose({ element, hasInvalidInput, requestSubmit: () => element.value?.requestSubmit?.() });
</script>
<template>
  <AForm
    ref="form"
    class="todo-form todo-form-layout"
    :disabled="busy"
    :aria-busy="busy || undefined"
    @submit="submit"
    @invalid.capture="emit('invalid', $event)"
  >
    <fieldset class="todo-form-fields" :disabled="busy"><slot /></fieldset>
    <footer v-if="$slots.actions" class="todo-actions todo-form-footer">
      <slot name="actions" />
    </footer>
  </AForm>
</template>
<style src="../../to-doo-form-layout.css"></style>
