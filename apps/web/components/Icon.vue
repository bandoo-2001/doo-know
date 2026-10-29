<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  apps: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  commit: 'M3 12h5m8 0h5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  sidebar: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM8 3v18',
  undo: 'm8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12h-3',
  redo: 'm16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12h3',
  'align-left': 'M3 5h18M3 10h12M3 15h18M3 20h12',
  'align-center': 'M3 5h18M6 10h12M3 15h18M6 20h12',
  'align-right': 'M3 5h18M9 10h12M3 15h18M9 20h12',
  back: 'm15 5-7 7 7 7',
  forward: 'm9 5 7 7-7 7',
  quote: 'M5 5h5v7H5c0 4 1 5 4 5M14 5h5v7h-5c0 4 1 5 4 5',
  list: 'M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01',
  ordered: 'M10 6h11M10 12h11M10 18h11M3 4h1v5M2 9h4M2 14c0-2 4-2 4 0 0 1-4 3-4 5h4',
  task: 'M9 6h12M9 12h12M9 18h12M2 5l2 2 3-4M2 11l2 2 3-4M2 17l2 2 3-4',
  indent: 'M3 4h18M10 9h11M10 15h11M3 20h18m-18-12 4 4-4 4',
  outdent: 'M3 4h18M10 9h11M10 15h11M3 20h18m-14-12-4 4 4 4',
  link: 'm10 14 4-4M9 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M15 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  'inline-code': 'm8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16',
  code: 'M4 3h16v18H4Zm4 5-3 4 3 4m8-8 3 4-3 4M13 7l-2 10',
  table: 'M3 4h18v16H3ZM3 9h18M9 4v16M15 9v11M3 14h18',
  rule: 'M3 12h18',
  book: 'M12 6C9 3 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 2Zm0 0v15',
  folder: 'M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h6',
  search: 'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  plus: 'M12 5v14M5 12h14',
  plug: 'M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0ZM12 18v4',
  'git-branch':
    'M6 9v6M6 12h6a6 6 0 0 0 6-6M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  power: 'M12 2v10M6.3 5.3a9 9 0 1 0 11.4 0',
  download: 'M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5',
  'arrow-up': 'M12 20V4m-7 7 7-7 7 7',
  keyboard: 'M3 5h18v14H3ZM7 9h.01M12 9h.01M17 9h.01M7 12h.01M12 12h.01M17 12h.01M7 16h10',
  monitor: 'M3 3h18v14H3ZM12 17v4M8 21h8',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2',
  'hard-drive': 'M5 3h14l3 12v6H2v-6ZM2 15h20M6 18h.01M10 18h.01',
  shield: 'M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7ZM8 12l3 3 5-6',
  help: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  activity: 'M2 12h4l3-9 6 18 3-9h4',
  cloud: 'M7 18a5 5 0 1 1 1-9 7 7 0 0 1 13 3 3 3 0 0 1-1 6Z',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  share:
    'M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6M6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6M9 11l6-4M9 13l6 4',
  save: 'M4 3h13l4 4v14H3V3Zm3 0v7h10V3M7 21v-7h10v7',
  chevron: 'm9 5 7 7-7 7',
  menu: 'M3 6h18M3 12h18M3 18h18',
  lock: 'M6 11V7a6 6 0 0 1 12 0v4M4 11h16v11H4Zm8 4v3',
  key: 'M15 3a6 6 0 1 1-4 10l-8 8H1v-4l8-8a6 6 0 0 1 6-6ZM17 7h.01',
  clock: 'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  star: 'm12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91Z',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
  whiteboard: 'M4 3h16v14H4Zm8 14v4m-5 0h10M7 13l4-5 3 3 3-5',
  image: 'M3 3h18v18H3Zm0 14 5-5 4 4 3-3 6 6M8 7h.01',
  refresh: 'M3 11a9 9 0 0 1 15-7l3 3M21 3v4h-4M21 13a9 9 0 0 1-15 7l-3-3M3 21v-4h4',
  logout: 'M9 3H3v18h6M13 7l5 5-5 5M7 12h14',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  copy: 'M8 8h13v13H8ZM3 16V3h13',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  'row-before': 'M3 10h18v11H3ZM3 15.5h18M9 10v11M15 10v11M9 4.5h6M12 1.5v6',
  'row-after': 'M3 3h18v11H3ZM3 8.5h18M9 3v11M15 3v11M9 19.5h6M12 16.5v6',
  'row-delete': 'M3 3h18v11H3ZM3 8.5h18M9 3v11M15 3v11M9 19.5h6',
  'column-before': 'M10 3h11v18H10ZM15.5 3v18M10 9h11M10 15h11M1.5 12h6M4.5 9v6',
  'column-after': 'M3 3h11v18H3ZM8.5 3v18M3 9h11M3 15h11M16.5 12h6M19.5 9v6',
  'column-delete': 'M3 3h11v18H3ZM8.5 3v18M3 9h11M3 15h11M16.5 12h6',
  'text-style': 'm3 20 6-16 6 16M5 15h8M17 7h4M17 12h4M17 17h4',
};
</script>
<template>
  <svg
    :width="size || 20"
    :height="size || 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'more'">
      <circle
        v-for="cx in [5, 12, 19]"
        :key="cx"
        :cx="cx"
        cy="12"
        r="1.8"
        fill="currentColor"
        stroke="none"
      />
    </template>
    <path v-else :d="paths[name] || paths.file" />
  </svg>
</template>
