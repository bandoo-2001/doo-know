<script setup lang="ts">
withDefaults(
  defineProps<{
    label?: string;
    variant?: 'page' | 'document' | 'list' | 'inline';
  }>(),
  { label: '正在加载…', variant: 'document' },
);
</script>

<template>
  <div
    class="loading-state"
    :class="`loading-state-${variant}`"
    role="status"
    :aria-label="label"
    aria-live="polite"
    aria-busy="true"
  >
    <div class="loading-state-message">
      <span class="loading-state-ring" aria-hidden="true"></span>
      <span>{{ label }}</span>
    </div>
    <div v-if="variant !== 'inline'" class="loading-state-skeleton" aria-hidden="true">
      <span v-for="line in 5" :key="line" class="loading-state-line"></span>
    </div>
  </div>
</template>

<style scoped>
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  width: 100%;
  min-width: 0;
  padding: 36px 28px;
  color: var(--muted, #7188a3);
  font-size: 13px;
  line-height: 1.6;
}

.loading-state-message {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.loading-state-ring {
  display: inline-block;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border: 2px solid var(--border, #dae8f5);
  border-top-color: var(--blue, #4566c6);
  border-radius: 50%;
  animation: loading-state-spin 850ms linear infinite;
}

.loading-state-skeleton {
  display: grid;
  gap: 14px;
  width: min(100%, 580px);
}

.loading-state-line {
  position: relative;
  display: block;
  height: 10px;
  overflow: hidden;
  border-radius: 5px;
  background: color-mix(in srgb, var(--muted, #7188a3) 12%, transparent);
}

.loading-state-line::after {
  position: absolute;
  inset: 0;
  content: '';
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--panel, #fff) 55%, transparent),
    transparent
  );
  transform: translateX(-100%);
  animation: loading-state-shimmer 1.7s ease-in-out infinite;
}

.loading-state-line:first-child {
  width: 42%;
  height: 16px;
  margin-bottom: 8px;
}

.loading-state-line:nth-child(3) {
  width: 88%;
}

.loading-state-line:last-child {
  width: 65%;
}

.loading-state-page {
  min-height: 100vh;
  min-height: 100svh;
  gap: 32px;
  background: var(--panel, #fff);
}

.loading-state-page .loading-state-skeleton {
  max-width: 340px;
}

.loading-state-document {
  min-height: 220px;
  flex: 1;
}

.loading-state-list {
  align-items: stretch;
  justify-content: flex-start;
  gap: 22px;
  padding: 22px 16px;
}

.loading-state-list .loading-state-message {
  justify-content: flex-start;
}

.loading-state-list .loading-state-line:first-child {
  height: 10px;
  margin: 0;
  width: 70%;
}

.loading-state-inline {
  flex-direction: row;
  width: auto;
  padding: 10px 12px;
}

.loading-state-inline .loading-state-ring {
  width: 16px;
  height: 16px;
}

@keyframes loading-state-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes loading-state-shimmer {
  to {
    transform: translateX(100%);
  }
}

@media (max-width: 600px) {
  .loading-state-page,
  .loading-state-document {
    padding: 28px 20px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .loading-state-ring,
  .loading-state-line::after {
    animation: none;
  }
}
</style>
