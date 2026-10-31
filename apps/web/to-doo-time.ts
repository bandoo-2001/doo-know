import { onActivated, onDeactivated, onMounted, ref } from 'vue';
import { useEventListener, useIntervalFn } from '@vueuse/core';

/** Wall-clock refresh shared by date-based pages; domain durations use stored segments. */
export function useToDooClock(interval = 60000) {
  const now = ref(Date.now()),
    active = ref(true);
  const timer = useIntervalFn(() => (now.value = Date.now()), interval, { immediate: false });
  const resume = () => {
    active.value = true;
    now.value = Date.now();
    timer.resume();
  };
  onMounted(resume);
  onActivated(resume);
  onDeactivated(() => {
    active.value = false;
    timer.pause();
  });
  useEventListener(
    () => (active.value && typeof document !== 'undefined' ? document : undefined),
    'visibilitychange',
    () => {
      if (document.visibilityState === 'visible') now.value = Date.now();
    },
  );
  return { now, active };
}
