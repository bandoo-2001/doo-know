<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Modal as AModal } from 'ant-design-vue';
import {
  readDocumentProperties,
  updateDocumentProperties,
  type DocumentPropertyValue,
} from '../../../shared/frontmatter';

const props = defineProps<{ markdown: string; readOnly?: boolean }>();
const emit = defineEmits<{ apply: [markdown: string]; close: [] }>();
type Field = {
  key: string;
  text: string;
  initial: string;
  type: 'text' | 'number' | 'boolean' | 'list';
  editable: boolean;
  added?: boolean;
};
const parsed = computed(() => readDocumentProperties(props.markdown));
const fields = ref<Field[]>([]);
const newKey = ref('');
const message = ref('');
const labels: Record<string, string> = {
  title: '标题',
  tags: '标签',
  aliases: '别名',
  status: '状态',
};

watch(
  () => props.markdown,
  () => {
    fields.value = parsed.value.properties.map((property) => {
      const value = property.value;
      const type = Array.isArray(value)
        ? 'list'
        : typeof value === 'number'
          ? 'number'
          : typeof value === 'boolean'
            ? 'boolean'
            : 'text';
      const text = Array.isArray(value)
        ? value.join('\n')
        : value === null || value === undefined
          ? ''
          : String(value);
      const editable =
        property.editable &&
        (!Array.isArray(value) || value.every((item) => typeof item === 'string'));
      return { key: property.key, text, initial: text, type, editable };
    });
    for (const key of ['title', 'tags'])
      if (!fields.value.some((field) => field.key === key))
        fields.value.push({
          key,
          text: '',
          initial: '',
          type: key === 'tags' ? 'list' : 'text',
          editable: true,
        });
    newKey.value = '';
    message.value = '';
  },
  { immediate: true },
);

function add() {
  if (props.readOnly || parsed.value.error) return;
  const key = newKey.value.trim();
  if (!key) return;
  if (fields.value.some((field) => field.key === key)) {
    message.value = '此属性已存在';
    return;
  }
  fields.value.push({
    key,
    text: '',
    initial: '',
    type: key === 'tags' || key === 'aliases' ? 'list' : 'text',
    editable: true,
    added: true,
  });
  newKey.value = '';
  message.value = '';
}

function apply() {
  if (props.readOnly || parsed.value.error) return;
  const updates: Record<string, DocumentPropertyValue> = Object.create(null);
  for (const field of fields.value) {
    if (!field.editable || (!field.added && field.text === field.initial)) continue;
    if (field.type === 'number') {
      if (!field.text.trim() || !Number.isFinite(Number(field.text))) {
        message.value = `“${field.key}”需要填写数字`;
        return;
      }
      updates[field.key] = Number(field.text);
    } else if (field.type === 'boolean') updates[field.key] = field.text === 'true';
    else if (field.type === 'list')
      updates[field.key] = field.text
        .split(/[,，\r\n]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    else updates[field.key] = field.text;
  }
  const result = updateDocumentProperties(props.markdown, updates);
  if (!result.ok) message.value = result.message;
  else emit('apply', result.markdown);
}
</script>

<template>
  <AModal :open="true" title="笔记属性" :width="560" :footer="null" @cancel="emit('close')">
    <form class="document-properties" @submit.prevent="apply">
      <p class="properties-description">
        属性保存在笔记开头的 YAML 中。更改会进入当前草稿，保存笔记后生效。
      </p>
      <p v-if="parsed.error" role="alert" class="properties-message">{{ parsed.error }}</p>
      <p v-if="!parsed.error && !fields.length" class="properties-description">
        暂时没有属性。可添加 title、tags、aliases 或其他名称。
      </p>
      <div v-for="(field, index) in fields" :key="field.key" class="property-field">
        <label :for="`document-property-${index}`">{{ labels[field.key] || field.key }}</label>
        <span v-if="!field.editable" class="properties-description"
          >复杂属性，原文已保留；可在源码中编辑。</span
        >
        <textarea
          v-else-if="field.type === 'list'"
          :id="`document-property-${index}`"
          v-model="field.text"
          :readonly="readOnly"
          rows="3"
          placeholder="用逗号、中文逗号或换行分隔"
        />
        <select
          v-else-if="field.type === 'boolean'"
          :id="`document-property-${index}`"
          v-model="field.text"
          :disabled="readOnly"
        >
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
        <input
          v-else
          :id="`document-property-${index}`"
          v-model="field.text"
          :readonly="readOnly"
          :type="field.type === 'number' ? 'number' : 'text'"
          step="any"
        />
      </div>
      <div v-if="!readOnly && !parsed.error" class="property-add">
        <input
          v-model="newKey"
          aria-label="新属性名称"
          placeholder="新属性名称"
          maxlength="128"
          @keydown.enter.prevent="add"
        />
        <button type="button" class="btn" :disabled="!newKey.trim()" @click="add">添加属性</button>
      </div>
      <p v-if="message" role="alert" class="properties-message">{{ message }}</p>
      <div class="properties-actions">
        <button type="button" class="btn" @click="emit('close')">
          {{ readOnly ? '关闭' : '取消' }}
        </button>
        <button v-if="!readOnly" type="submit" class="btn primary" :disabled="!!parsed.error">
          应用到草稿
        </button>
      </div>
    </form>
  </AModal>
</template>

<style scoped>
.document-properties {
  color: var(--text);
}
.properties-description {
  margin: 0 0 14px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}
.property-field {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}
.property-field label {
  font-weight: 600;
}
.property-field input,
.property-field textarea,
.property-field select,
.property-add input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  background: var(--panel, #fff);
  font: inherit;
}
.property-field textarea {
  resize: vertical;
}
.property-add {
  display: flex;
  gap: 8px;
  margin: 16px 0;
}
.property-add input {
  min-width: 0;
  flex: 1;
}
.property-add button {
  flex-shrink: 0;
}
.properties-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
.properties-message {
  color: var(--danger, #b42318);
  font-size: 13px;
}
</style>
