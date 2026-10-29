import { reactive, watch } from 'vue';
import type { GraphQuery, KnowledgeGraphResponse } from '../../shared/graph-contracts';
export function createGraphWorkbench(request: (url: string) => Promise<KnowledgeGraphResponse>) {
  const state = reactive({
    query: { depth: 1, mode: 'all' } as GraphQuery,
    result: undefined as KnowledgeGraphResponse | undefined,
    resultQuery: undefined as GraphQuery | undefined,
    selectedId: '',
    loading: false,
    error: '',
  });
  let generation = 0;
  let disposed = false;
  const stopQueryWatch = watch(
    () => state.query,
    () => {
      generation++;
      state.loading = false;
    },
    { deep: true, flush: 'sync' },
  );
  async function load() {
    if (disposed) return;
    const current = ++generation;
    const query = { ...state.query };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== '') params.set(key, String(value));
    state.loading = true;
    state.error = '';
    try {
      // A manual refresh opens at most three bounded index batches. Never poll forever.
      for (let batch = 0; batch < 3; batch++) {
        const result = await request(`/api/graph?${params}`);
        if (disposed || generation !== current) return;
        state.result = result;
        state.resultQuery = query;
        if (!result.nodes.some((node) => node.id === state.selectedId)) state.selectedId = '';
        if (result.index.complete || !result.index.pending) break;
      }
    } catch (cause) {
      if (!disposed && generation === current)
        state.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!disposed && generation === current) state.loading = false;
    }
  }
  return {
    state,
    load,
    select(id: string) {
      state.selectedId = id;
    },
    dispose() {
      stopQueryWatch();
      disposed = true;
      generation++;
      state.loading = false;
    },
  };
}
