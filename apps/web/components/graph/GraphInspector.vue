<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Button as AButton } from 'ant-design-vue';
import type {
  GraphKnowledgeNode,
  GraphKnowledgeEdge,
} from '../../../../shared/graph-semantic-contracts';
import type { GraphCommandInput } from '../../graph-workbench';
import { graphLabels, graphReviewStatusLabels } from './labels';
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
      <AButton aria-label="关闭详情" @click="emit('close')">×</AButton>
    </div>
    <template v-if="node"
      ><p>{{ node.description || node.relativePath }}</p>
      <small
        >{{ graphLabels[node.kind] || '知识' }} · {{ node.sourceCount }} 来源 ·
        {{ node.community ? '已归入关系分组' : '尚未分组' }}</small
      >
      <p v-if="node.aliases?.length">别名：{{ node.aliases.join('、') }}</p>
      <AButton v-if="node.kind === 'note'" @click="emit('open', node.id)">打开原文</AButton>
      <div class="graph-actions">
        <AButton @click="emit('focus', 1)">1 跳关系</AButton
        ><AButton @click="emit('focus', 2)">2 跳关系</AButton>
      </div>
      <details v-if="node.kind !== 'note'">
        <summary>整理实体</summary>
        <label>新增别名<input v-model="alias" maxlength="100" /></label
        ><AButton
          :disabled="!alias.trim() || busy"
          @click="emit('command', { action: 'alias', entityId: node.id, alias })"
          >保存别名</AButton
        ><label
          >合并到<select v-model="into">
            <option value="">选择实体</option>
            <option
              v-for="n in nodes.filter((n) => n.kind !== 'note' && n.id !== node?.id)"
              :key="n.id"
              :value="n.id"
            >
              {{ n.title }}
            </option>
          </select></label
        ><AButton
          :disabled="!into || busy"
          @click="emit('command', { action: 'merge', from: node.id, into })"
          >合并实体</AButton
        >
      </details>
      <details v-if="node.kind !== 'note'">
        <summary>新增人工关系</summary>
        <label
          >目标<select v-model="target">
            <option value="">选择目标</option>
            <option
              v-for="n in nodes.filter((n) => n.kind !== 'note' && n.id !== node?.id)"
              :key="n.id"
              :value="n.id"
            >
              {{ n.title }}
            </option>
          </select></label
        ><label>关系<input v-model="predicate" maxlength="100" /></label
        ><label
          >原文依据<select v-model="noteId">
            <option value="">选择来源笔记</option>
            <option v-for="n in nodes.filter((n) => n.kind === 'note')" :key="n.id" :value="n.id">
              {{ n.title }}
            </option>
            <option
              v-for="ev in evidence.filter((e) => !nodes.some((n) => n.id === e.noteId))"
              :key="ev.id"
              :value="ev.noteId"
            >
              {{ ev.title }}
            </option>
          </select></label
        ><AButton
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
      </details></template
    ><template v-if="edge"
      ><p>
        {{ graphLabels[edge.kind] || '关系' }} ·
        {{ graphReviewStatusLabels[edge.status] || '待审核' }} · 置信度
        {{ Math.round(edge.confidence * 100) }}%
      </p>
      <div class="graph-actions">
        <AButton @click="emit('select', edge.source)">查看起点</AButton
        ><AButton @click="emit('select', edge.target)">查看终点</AButton>
      </div>
      <template v-if="edge.kind === 'semantic'"
        ><label>关系名称<input v-model="edgePredicate" /></label>
        <div class="graph-actions">
          <AButton
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
          ><AButton
            :disabled="busy"
            @click="emit('command', { action: 'review', id: edge.id, decision: 'ignore' })"
            >忽略关系</AButton
          >
        </div></template
      ></template
    >
    <h3>原文证据</h3>
    <p v-if="!evidence.length">此项暂无可显示的原文证据。</p>
    <article v-for="ev in evidence" :key="ev.id" class="graph-evidence">
      <blockquote>{{ ev.quote }}</blockquote>
      <AButton size="small" @click="emit('open', ev.noteId, ev.startLine)"
        >{{ ev.title }} · L{{ ev.startLine }}–{{ ev.endLine }}</AButton
      ><small
        >{{
          ev.method === 'local' ? '基础词项分析' : ev.method === 'model' ? '模型提取' : '人工关系'
        }}{{ ev.model ? ' · ' + ev.model : '' }}</small
      >
    </article>
  </div>
</template>
