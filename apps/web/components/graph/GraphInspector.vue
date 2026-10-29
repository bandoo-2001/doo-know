<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import {
  Button as AButton,
  Card as ACard,
  Collapse as ACollapse,
  CollapsePanel as ACollapsePanel,
  Divider as ADivider,
  Empty as AEmpty,
  Form as AForm,
  FormItem as AFormItem,
  Input as AInput,
  Select as ASelect,
  Space as ASpace,
  Tag as ATag,
} from 'ant-design-vue';
import type {
  GraphKnowledgeNode,
  GraphKnowledgeEdge,
} from '../../../../shared/graph-semantic-contracts';
import type { GraphCommandInput } from '../../graph-workbench';
import { graphLabels, graphReviewStatusLabels } from './labels';
const formId = `graph-inspector-${useId()}`;
const props = defineProps<{
  node?: GraphKnowledgeNode;
  edge?: GraphKnowledgeEdge;
  nodes: GraphKnowledgeNode[];
  busy: boolean;
}>();
const emit = defineEmits<{
  close: [];
  focus: [depth: 1 | 2];
  open: [id: string, line?: number];
  command: [input: GraphCommandInput];
  select: [id: string];
}>();
const alias = ref(''),
  into = ref(''),
  target = ref(''),
  predicate = ref('关联'),
  noteId = ref('');
const evidence = computed(() => props.node?.evidence || props.edge?.evidence || []);
const entityOptions = computed(() =>
  props.nodes
    .filter((node) => node.kind !== 'note' && node.id !== props.node?.id)
    .map((node) => ({
      label: `${node.title} · ${graphLabels[node.kind] || '实体'}`,
      value: node.id,
    })),
);
const noteOptions = computed(() => {
  const notes = new Map(
    props.nodes.filter((node) => node.kind === 'note').map((node) => [node.id, node.title]),
  );
  for (const item of evidence.value) {
    if (!notes.has(item.noteId)) notes.set(item.noteId, item.title);
  }
  return Array.from(notes, ([value, label]) => ({ value, label }));
});
watch(
  () => props.node?.id,
  () => {
    alias.value = '';
    into.value = '';
    target.value = '';
    noteId.value = '';
  },
);
const edgePredicate = ref('');
watch(
  () => [props.edge?.id, props.edge?.label] as const,
  ([id, label], previous) => {
    // Background refreshes must not replace a predicate the user is editing.
    if (id !== previous?.[0] || edgePredicate.value === (previous?.[1] || ''))
      edgePredicate.value = label || '';
  },
  { immediate: true },
);
</script>
<template>
  <div class="graph-panel graph-inspector">
    <div class="graph-inspector-heading">
      <h2>{{ node?.title || edge?.label || '详情' }}</h2>
      <AButton type="text" aria-label="关闭详情" @click="emit('close')">×</AButton>
    </div>
    <template v-if="node">
      <ASpace wrap :size="[4, 8]">
        <ATag color="blue">{{ graphLabels[node.kind] || '知识' }}</ATag>
        <span class="inspector-muted">{{ node.sourceCount }} 来源</span>
        <span class="inspector-muted">{{ node.community ? '已归入关系分组' : '尚未分组' }}</span>
      </ASpace>
      <p class="inspector-description">{{ node.description || node.relativePath }}</p>
      <ASpace v-if="node.aliases?.length" wrap :size="[4, 4]" class="inspector-aliases">
        <span class="inspector-muted">别名</span>
        <ATag v-for="name in node.aliases" :key="name">{{ name }}</ATag>
      </ASpace>
      <ASpace wrap class="inspector-actions">
        <AButton v-if="node.kind === 'note'" type="primary" @click="emit('open', node.id)"
          >打开原文</AButton
        >
        <AButton @click="emit('focus', 1)">1 跳关系</AButton>
        <AButton @click="emit('focus', 2)">2 跳关系</AButton>
      </ASpace>
      <ACollapse v-if="node.kind !== 'note'" ghost class="inspector-management">
        <ACollapsePanel key="organize" header="整理实体">
          <AForm :name="`${formId}-organize`" layout="vertical" :required-mark="false">
            <AFormItem name="alias" label="新增别名">
              <AInput
                v-model:value="alias"
                aria-label="新增别名"
                :maxlength="100"
                placeholder="输入实体的其他名称"
              />
            </AFormItem>
            <AButton
              :disabled="!alias.trim() || busy"
              @click="emit('command', { action: 'alias', entityId: node.id, alias })"
              >保存别名</AButton
            >
            <ADivider />
            <AFormItem name="into" label="合并到">
              <ASelect
                :value="into || undefined"
                @update:value="(value) => (into = typeof value === 'string' ? value : '')"
                aria-label="合并到"
                :options="entityOptions"
                :show-search="true"
                option-filter-prop="label"
                placeholder="选择实体"
              />
            </AFormItem>
            <AButton
              :disabled="!into || busy"
              @click="emit('command', { action: 'merge', from: node.id, into })"
              >合并实体</AButton
            >
          </AForm>
        </ACollapsePanel>
        <ACollapsePanel key="relation" header="新增人工关系">
          <AForm :name="`${formId}-relation`" layout="vertical" :required-mark="false">
            <AFormItem name="target" label="目标">
              <ASelect
                :value="target || undefined"
                @update:value="(value) => (target = typeof value === 'string' ? value : '')"
                aria-label="目标"
                :options="entityOptions"
                show-search
                option-filter-prop="label"
                placeholder="选择目标"
              />
            </AFormItem>
            <AFormItem name="predicate" label="关系">
              <AInput v-model:value="predicate" aria-label="关系" :maxlength="100" />
            </AFormItem>
            <AFormItem name="noteId" label="原文依据">
              <ASelect
                :value="noteId || undefined"
                @update:value="(value) => (noteId = typeof value === 'string' ? value : '')"
                aria-label="原文依据"
                :options="noteOptions"
                show-search
                option-filter-prop="label"
                placeholder="选择来源笔记"
              />
            </AFormItem>
            <AButton
              type="primary"
              :disabled="!target || !predicate.trim() || !noteId || busy"
              @click="
                emit('command', {
                  action: 'manual-relation',
                  source: node.id,
                  target,
                  predicate,
                  noteId,
                })
              "
              >添加关系</AButton
            >
          </AForm>
        </ACollapsePanel>
      </ACollapse>
    </template>
    <template v-if="edge">
      <ASpace wrap :size="[4, 8]">
        <ATag>{{ graphLabels[edge.kind] || '关系' }}</ATag>
        <ATag
          v-if="edge.kind !== 'similarity'"
          :color="edge.status === 'accepted' ? 'green' : edge.status === 'manual' ? 'blue' : 'gold'"
          >{{ graphReviewStatusLabels[edge.status] || '待审核' }}</ATag
        >
        <span v-if="edge.similarity" class="inspector-muted"
          >余弦相似度 {{ edge.similarity.score.toFixed(3) }}</span
        >
        <span v-else class="inspector-muted">置信度 {{ Math.round(edge.confidence * 100) }}%</span>
      </ASpace>
      <p v-if="edge.similarity" class="inspector-muted">
        来自现有向量模型的内容相近线索，分数表示相似程度，不能作为事实关系的证据。
      </p>
      <ASpace wrap class="inspector-actions">
        <AButton @click="emit('select', edge.source)">查看起点</AButton>
        <AButton @click="emit('select', edge.target)">查看终点</AButton>
      </ASpace>
      <AForm
        v-if="edge.kind === 'semantic'"
        :name="`${formId}-review`"
        layout="vertical"
        :required-mark="false"
      >
        <AFormItem name="edgePredicate" label="关系名称">
          <AInput v-model:value="edgePredicate" aria-label="关系名称" />
        </AFormItem>
        <ASpace wrap>
          <AButton
            type="primary"
            :disabled="busy || !edgePredicate.trim()"
            @click="
              emit('command', {
                action: 'review',
                id: edge.id,
                decision: 'accept',
                predicate: edgePredicate,
              })
            "
            >确认 / 保存</AButton
          >
          <AButton
            :disabled="busy"
            @click="emit('command', { action: 'review', id: edge.id, decision: 'ignore' })"
            >忽略关系</AButton
          >
        </ASpace>
      </AForm>
    </template>
    <ADivider orientation="left"
      >原文证据 <span class="inspector-muted">{{ evidence.length }}</span></ADivider
    >
    <AEmpty
      v-if="!evidence.length"
      :image="AEmpty.PRESENTED_IMAGE_SIMPLE"
      description="此项暂无可显示的原文证据。"
    />
    <ASpace v-else direction="vertical" :size="12" class="inspector-evidence-list">
      <ACard
        v-for="ev in evidence"
        :key="ev.id"
        size="small"
        class="graph-evidence inspector-evidence-card"
      >
        <blockquote>{{ ev.quote }}</blockquote>
        <AButton
          type="link"
          size="small"
          class="inspector-source"
          @click="emit('open', ev.noteId, ev.startLine)"
          >{{ ev.title }} · L{{ ev.startLine }}–{{ ev.endLine }}</AButton
        >
        <div class="inspector-muted inspector-evidence-method">
          {{
            ev.method === 'local'
              ? '基础词项分析'
              : ev.method === 'model'
                ? '模型提取'
                : ev.method === 'embedding'
                  ? '向量索引片段'
                  : '人工关系'
          }}{{ ev.model ? ' · ' + ev.model : '' }}
        </div>
      </ACard>
    </ASpace>
  </div>
</template>
<style scoped>
.inspector-muted {
  color: var(--muted, #687486);
  font-size: 12px;
}
.inspector-description {
  margin: 14px 0;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.inspector-aliases {
  margin-bottom: 14px;
}
.inspector-actions {
  display: flex;
  margin: 16px 0;
}
.inspector-management {
  margin: 8px -12px 0;
}
.inspector-management :deep(.ant-collapse-content-box) {
  padding-top: 8px;
}
:deep(.ant-form-item) {
  margin-bottom: 16px;
}
:deep(.ant-form-item-label) {
  padding-bottom: 6px;
}
:deep(.ant-select) {
  width: 100%;
}
.inspector-evidence-list {
  width: 100%;
}
.inspector-evidence-card {
  margin: 0;
  background: var(--surface-soft, #f5f6f8);
}
.inspector-evidence-card blockquote {
  margin: 0 0 10px;
  padding: 0;
  border: 0;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.inspector-source {
  height: auto;
  padding: 0;
  white-space: normal;
  text-align: left;
}
.inspector-evidence-method {
  margin-top: 6px;
  overflow-wrap: anywhere;
}
</style>
