import { reactive, watch } from 'vue';
import { graphRequestId } from './graph-request';
import type {
  GraphExploreQuery,
  GraphKnowledgeResponse,
  GraphAnalysisStatus,
  GraphModelSettings,
  GraphUserState,
  GraphUserCommand,
  GraphReviewItem,
  GraphModelUpdate,
  GraphQuestionResponse,
} from '../../shared/graph-semantic-contracts';
type Request = (url: string, method?: string, body?: unknown) => Promise<any>;
export function createGraphWorkbench(request: Request) {
  const state = reactive({
    query: {
      view: 'knowledge',
      depth: 1,
      mode: 'all',
      limit: 80,
      includeSuggested: false,
      includeSimilarity: false,
    } as GraphExploreQuery,
    result: undefined as GraphKnowledgeResponse | undefined,
    resultQuery: undefined as GraphExploreQuery | undefined,
    selectedId: '',
    loading: false,
    busy: false,
    error: '',
    status: undefined as GraphAnalysisStatus | undefined,
    settings: undefined as GraphModelSettings | undefined,
    user: { version: 0, views: [] } as GraphUserState,
    reviews: [] as GraphReviewItem[],
    reviewLoading: false,
    reviewHasMore: false,
    answer: undefined as GraphQuestionResponse | undefined,
  });
  let reviewGeneration = 0;
  let activeReview = { status: 'suggested', q: '' };
  let pendingCommand: { intent: string; payload: GraphUserCommand } | undefined;
  let generation = 0,
    disposed = false,
    polling = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = watch(
    () => state.query,
    () => {
      generation++;
      state.loading = false;
    },
    { deep: true, flush: 'sync' },
  );
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  async function load() {
    if (disposed) return;
    const current = ++generation;
    const query = structuredClone(JSON.parse(JSON.stringify(state.query))) as GraphExploreQuery;
    query.includeSuggested ??= false;
    query.includeSimilarity ??= false;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== '')
        params.set(key, Array.isArray(value) ? value.join(',') : String(value));
    state.loading = true;
    state.error = '';
    try {
      const received: GraphKnowledgeResponse = await request(`/api/graph/explore?${params}`);
      // Bound the published view, so canvas, list, inspector and export share exactly the same edges.
      const result = {
        ...received,
        edges: received.edges.slice(0, 120),
        truncated: received.truncated || received.edges.length > 120,
      };
      if (disposed || generation !== current) return;
      state.result = result;
      state.resultQuery = query;
      state.status = result.status;
      if (![...result.nodes, ...result.edges].some((item) => item.id === state.selectedId))
        state.selectedId = '';
    } catch (e) {
      if (!disposed && generation === current) state.error = message(e);
    } finally {
      if (!disposed && generation === current) state.loading = false;
    }
  }
  async function mutate<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (state.busy || disposed) return;
    state.busy = true;
    state.error = '';
    try {
      return await operation();
    } catch (e) {
      if (!disposed) state.error = message(e);
      return undefined;
    } finally {
      state.busy = false;
    }
  }
  async function command(input: GraphCommandInput) {
    return mutate(async () => {
      const intent = JSON.stringify(input, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      );
      if (!pendingCommand || pendingCommand.intent !== intent)
        pendingCommand = {
          intent,
          payload: JSON.parse(
            JSON.stringify({
              ...input,
              expectedVersion: state.user.version,
              requestId: graphRequestId(),
            }),
          ),
        };
      const attempt = pendingCommand;
      try {
        const user = await request('/api/graph/commands', 'POST', structuredClone(attempt.payload));
        if (pendingCommand === attempt) pendingCommand = undefined;
        if (disposed) return;
        state.user = user;
      } catch (error) {
        const failure = error as {
          status?: number;
          message?: string;
          data?: { code?: string; error?: string | { code?: string } };
        };
        const code =
          failure.data?.code ||
          (typeof failure.data?.error === 'string'
            ? failure.data.error
            : failure.data?.error?.code) ||
          failure.message;
        if (code === 'VERSION_CONFLICT' && pendingCommand === attempt) pendingCommand = undefined;
        if (failure.status === 409 && !disposed) {
          const user = await request('/api/graph/state');
          if (!disposed) state.user = user;
        }
        throw error;
      }
      await load();
      await review(activeReview.status, activeReview.q);
      return state.user;
    });
  }
  async function review(status = 'suggested', q = '', append = false) {
    if (disposed || (append && state.reviewLoading)) return;
    const current = ++reviewGeneration;
    const sameScope = activeReview.status === status && activeReview.q === q;
    const offset = append && sameScope ? state.reviews.length : 0;
    activeReview = { status, q };
    if (!offset) {
      state.reviews = [];
      state.reviewHasMore = false;
    }
    state.reviewLoading = true;
    const params = new URLSearchParams({ status, limit: '50', offset: String(offset) });
    if (q.trim()) params.set('q', q.trim());
    try {
      const result: GraphReviewItem[] = await request(`/api/graph/review?${params}`);
      if (!disposed && current === reviewGeneration) {
        state.reviews = offset ? [...state.reviews, ...result] : result;
        state.reviewHasMore = result.length === 50;
      }
    } catch (error) {
      if (!disposed && current === reviewGeneration) state.error = message(error);
    } finally {
      if (!disposed && current === reviewGeneration) state.reviewLoading = false;
    }
  }
  async function initialize() {
    const results = await Promise.allSettled([
      load(),
      request('/api/graph/settings').then((value) => {
        if (!disposed) state.settings = value;
      }),
      request('/api/graph/state').then((value) => {
        if (!disposed) state.user = value;
      }),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (!disposed && failure?.status === 'rejected') state.error = message(failure.reason);
  }
  async function poll() {
    if (disposed || !polling) return;
    if (typeof document === 'undefined' || !document.hidden) {
      try {
        const status = await request('/api/graph/status');
        if (!disposed) {
          const changed = state.result?.status?.revision !== status.revision;
          state.status = status;
          if (changed && !state.loading) await load();
        }
      } catch (e) {
        if (!disposed) state.error = message(e);
      }
    }
    if (!disposed && polling) timer = setTimeout(poll, 3000);
  }
  return {
    state,
    load,
    initialize,
    review,
    command,
    select(id: string) {
      state.selectedId = id;
    },
    startPolling() {
      if (!polling) {
        polling = true;
        timer = setTimeout(poll, 3000);
      }
    },
    job(action: string) {
      return mutate(async () => {
        state.status = await request('/api/graph/jobs', 'POST', { action });
        await load();
      });
    },
    saveSettings(update: GraphModelUpdate) {
      return mutate(async () => {
        const value = await request('/api/graph/settings', 'PUT', update);
        if (!disposed) state.settings = value;
        return value as GraphModelSettings;
      });
    },
    testSettings() {
      return mutate(() => request('/api/graph/settings/test', 'POST'));
    },
    ask(question: string) {
      return mutate(async () => {
        const value = await request('/api/graph/ask', 'POST', {
          question,
          ...(state.result?.nodes.some((n) => n.id === state.selectedId)
            ? { nodeId: state.selectedId }
            : {}),
        });
        if (!disposed) state.answer = value;
      });
    },
    dispose() {
      disposed = true;
      polling = false;
      clearTimeout(timer);
      stop();
      generation++;
      state.loading = false;
    },
  };
}
type Distribute<T> = T extends unknown ? Omit<T, 'requestId' | 'expectedVersion'> : never;
export type GraphCommandInput = Distribute<GraphUserCommand>;
