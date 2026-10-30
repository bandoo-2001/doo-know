<script setup lang="ts">
import { ref } from 'vue';
import { Button as AButton } from 'ant-design-vue';
import ToDooDateField from './ToDooDateField.vue';
const props = defineProps<{ modelValue: string[]; label: string }>();
const emit = defineEmits<{ 'update:modelValue': [dates: string[]] }>();
const date = ref(''),
  expanded = ref(false);
function add() {
  if (date.value && !props.modelValue.includes(date.value))
    emit('update:modelValue', [...props.modelValue, date.value].sort());
  date.value = '';
}
</script>
<template>
  <div class="todo-date-exceptions">
    <h3>
      {{ label }} <small class="todo-muted">{{ modelValue.length }} 天</small>
    </h3>
    <div class="todo-actions">
      <ToDooDateField v-model="date" type="date" :aria-label="label + '日期'" /><AButton
        type="default"
        class="todo-button"
        :disabled="!date"
        @click="add"
      >
        添加日期
      </AButton>
    </div>
    <div class="todo-actions">
      <span
        v-for="day in modelValue.slice(0, expanded ? modelValue.length : 20)"
        :key="day"
        class="todo-badge"
        >{{ day
        }}<AButton
          type="text"
          class="todo-icon-button"
          :aria-label="'移除 ' + label + ' ' + day"
          @click="
            emit(
              'update:modelValue',
              modelValue.filter((d) => d !== day),
            )
          "
        >
          ×
        </AButton></span
      ><AButton
        type="link"
        v-if="modelValue.length > 20"
        class="todo-link"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : '展开全部' }}
      </AButton>
    </div>
  </div>
</template>
