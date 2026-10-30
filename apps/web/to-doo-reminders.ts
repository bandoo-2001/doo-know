import { reactive } from 'vue';
import type { ToDooReminderCard, ToDooReminderFeed } from '../../shared/to-doo-reminders';
import type { ToDooRequest } from './to-doo-workbench';

const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const deliveryKey = (card: ToDooReminderCard) =>
  card.event.id + ':' + card.event.deliveryGeneration;

export function reminderIdFromUrl(href: string, origin: string): string | null {
  try {
    const url = new URL(href, origin);
    const id = url.searchParams.get('reminder');
    return url.origin === origin &&
      url.pathname === '/' &&
      url.searchParams.get('view') === 'apps' &&
      url.searchParams.get('app') === 'to-doo' &&
      validId(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

export function toDooReminderMessage(
  data: unknown,
): { kind: 'open'; id: string | null } | { kind: 'update' } | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Record<string, unknown>;
  if (message.type === 'dooknow-to-doo-reminder-update') return { kind: 'update' };
  if (message.type === 'dooknow-to-doo-open-reminder')
    return { kind: 'open', id: validId(message.eventId) ? message.eventId : null };
  return null;
}

export function createToDooReminderController(
  request: ToDooRequest,
  options: { now?: () => Date; changed?: () => void } = {},
) {
  const state = reactive({
    cards: [] as ToDooReminderCard[],
    missedCount: 0,
    timeZone: 'UTC',
    busy: '',
    error: '',
    loadError: '',
  });
  const suppressed = new Set<string>();
  const retries = new Map<string, Record<string, unknown>>();
  let disposed = false,
    generation = 0,
    activation = 0;
  let forced: ToDooReminderCard | null = null;
  async function refresh() {
    if (disposed || state.busy) return;
    const ticket = ++generation;
    try {
      const feed = (await request('/api/to-doo/reminders/pending')) as ToDooReminderFeed;
      let selected = forced;
      if (selected) {
        try {
          const updated = (await request(
            '/api/to-doo/reminders/' + encodeURIComponent(selected.event.id),
          )) as ToDooReminderCard;
          selected =
            updated.event.userState === 'read' && updated.event.revision !== selected.event.revision
              ? null
              : updated;
        } catch (cause) {
          if (
            (cause as { status?: number })?.status === 410 ||
            (cause as { status?: number })?.status === 404
          )
            selected = null;
          else throw cause;
        }
      }
      if (disposed || ticket !== generation) return;
      forced = selected;
      const cards = feed.reminders.filter((card) => !suppressed.has(deliveryKey(card)));
      if (selected) {
        state.cards = [selected, ...cards.filter((card) => card.event.id !== selected!.event.id)];
      } else state.cards = cards;
      state.missedCount = feed.missedCount;
      state.timeZone = feed.timeZone;
      state.loadError = '';
    } catch (cause) {
      if (!disposed && ticket === generation)
        state.loadError = cause instanceof Error ? cause.message : String(cause);
    }
  }
  async function open(id: string) {
    if (disposed || !validId(id)) return false;
    const ticket = ++activation;
    ++generation;
    state.error = '';
    try {
      const card = (await request(
        '/api/to-doo/reminders/' + encodeURIComponent(id),
      )) as ToDooReminderCard;
      if (disposed || ticket !== activation) return false;
      forced = card;
      state.cards = [card, ...state.cards.filter((other) => other.event.id !== card.event.id)];
      return true;
    } catch (cause) {
      if (!disposed && ticket === activation)
        state.error = cause instanceof Error ? cause.message : String(cause);
      return false;
    }
  }
  async function act(
    card: ToDooReminderCard,
    action: 'read' | 'acknowledge' | 'snooze' | 'complete',
    value: { minutes?: number; amount?: number } = {},
  ) {
    if (disposed || state.busy) return false;
    const key = [deliveryKey(card), card.event.revision, action, value.minutes, value.amount].join(
      ':',
    );
    let body = retries.get(key);
    if (!body) {
      body = {
        requestId: crypto.randomUUID(),
        expectedRevision: card.event.revision,
        ...(action === 'complete' ? {} : { action }),
        ...(action === 'snooze'
          ? {
              until: new Date(
                (options.now?.() ?? new Date()).getTime() + (value.minutes ?? 15) * 60000,
              ).toISOString(),
            }
          : {}),
        ...(action === 'complete' && value.amount !== undefined ? { amount: value.amount } : {}),
      };
      retries.set(key, body);
    }
    ++generation;
    state.busy = card.event.id;
    state.error = '';
    try {
      await request(
        '/api/to-doo/reminders/' +
          encodeURIComponent(card.event.id) +
          (action === 'complete' ? '/complete' : '/action'),
        'POST',
        body,
      );
      if (disposed) return false;
      suppressed.add(deliveryKey(card));
      if (forced?.event.id === card.event.id) forced = null;
      state.cards = state.cards.filter((other) => deliveryKey(other) !== deliveryKey(card));
      retries.delete(key);
      options.changed?.();
      return true;
    } catch (cause) {
      if (!disposed) state.error = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      if (!disposed) state.busy = '';
    }
  }
  function dispose() {
    disposed = true;
    ++generation;
    ++activation;
    state.cards = [];
    retries.clear();
    suppressed.clear();
    forced = null;
  }
  return { state, refresh, open, act, dispose };
}
