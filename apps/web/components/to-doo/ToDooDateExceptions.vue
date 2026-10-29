<script setup lang="ts">
import { ref } from 'vue';
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
      <input v-model="date" type="date" :aria-label="label + '日期'" /><button
        type="button"
        class="todo-button"
        :disabled="!date"
        @click="add"
      >
        添加日期
      </button>
    </div>
    <div class="todo-actions">
      <span
        v-for="day in modelValue.slice(0, expanded ? modelValue.length : 20)"
        :key="day"
        class="todo-badge"
        >{{ day
        }}<button
          type="button"
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
        </button></span
      ><button
        v-if="modelValue.length > 20"
        type="button"
        class="todo-link"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : '展开全部' }}
      </button>
    </div>
  </div>
</template>
