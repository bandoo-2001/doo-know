<script setup lang="ts">
import { Button as AButton } from 'ant-design-vue';
import ToDooIcon from './ToDooIcon.vue';

const emit = defineEmits<{ back: [] }>();
function reload() {
  window.location.reload();
}
</script>

<template>
  <section class="todo-app-load-error" role="alert" aria-label="To Doo 加载失败">
    <span class="todo-app-load-mark"><ToDooIcon name="tasks" :size="28" /></span>
    <h1>暂时无法打开 To Doo</h1>
    <p>请重新加载页面，或返回笔记继续使用。</p>
    <div class="todo-app-load-actions">
      <AButton type="primary" @click="reload">重新加载页面</AButton>
      <AButton aria-label="返回 DooKnow" @click="emit('back')">返回笔记</AButton>
    </div>
  </section>
</template>

<style scoped>
.todo-app-load-error {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 280px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 32px 20px;
  color: var(--todo-ink);
  background: var(--todo-bg);
  text-align: center;
}
.todo-app-load-mark {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 16px;
  color: var(--todo-accent);
  background: var(--todo-tint);
}
.todo-app-load-error h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}
.todo-app-load-error p {
  margin: 0;
  color: var(--todo-muted);
  line-height: 1.6;
}
.todo-app-load-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  margin-top: 4px;
}
</style>
