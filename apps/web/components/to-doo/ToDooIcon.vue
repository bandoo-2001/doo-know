<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });
const paths: Record<string, string> = {
  inbox: 'M4 4h16v16H4z M4 14h5l2 3h2l2-3h5',
  today: 'M8 3v4 M16 3v4 M4 10h16 M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1 M8 14h3v3H8z',
  upcoming:
    'M8 3v4 M16 3v4 M4 10h16 M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1 M8 14h1 M12 14h1 M16 14h1 M8 17h1 M12 17h1',
  tasks: 'm4 6 1 1 2-3 M10 6h10 m-16 6 1 1 2-3 M10 12h10 m-16 6 1 1 2-3 M10 18h10',
  list: 'M5 5h14 M5 12h14 M5 19h14',
  calendar: 'M8 3v4 M16 3v4 M4 10h16 M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1',
  overview: 'M12 3a9 9 0 1 0 9 9 M12 7a5 5 0 1 0 5 5 M12 12l8-8 M16 4h4v4',
  board: 'M4 4h6v16H4z M14 4h6v11h-6z',
  matrix: 'M4 4h16v16H4z M12 4v16 M4 12h16',
  timeline: 'M4 6h10 M10 12h10 M6 18h10',
  focus: 'M12 7v5l3 2 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
  habits: 'M20 7v5h-5 M4 17v-5h5 M5 8a8 8 0 0 1 13-3l2 2 M4 17l2 2a8 8 0 0 0 13-3',
  anniversaries: 'M12 20 3 11l9-9 9 9z',
  stats: 'M5 19V9 M12 19V4 M19 19v-6',
  notifications: 'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5z M10 21h4',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
  filter: 'M4 6h16 M7 12h10 M10 18h4',
  plus: 'M12 5v14 M5 12h14',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  chevron: 'm9 5 7 7-7 7',
  check: 'm5 12 4 4L19 6',
};
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="paths[name] || paths.list" />
  </svg>
</template>
