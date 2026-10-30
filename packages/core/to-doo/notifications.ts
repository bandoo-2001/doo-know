import { createHash, randomUUID } from 'node:crypto';
import webPush from 'web-push';
import type { AppDatabase } from '../db.js';
import type {
  ToDooDateTime,
  ToDooEntityMap,
  ToDooService,
  ToDooSnapshot,
} from '../../../shared/to-doo-contracts.js';
import { toDooDate } from '../../../shared/to-doo-contracts.js';
import { createToDooNetwork, type ToDooNetwork } from './network.js';
import { addDays, dateTimeInstant, localDate, nextAnniversary } from './recurrence.js';
import {
  getHabitRule,
  getHabitPeriod,
  summarizeHabitPeriod,
} from '../../../shared/to-doo-habits.js';

export type ReminderEvent = ToDooEntityMap['reminderEvent'];
export type ReminderPlan = Pick<
  ReminderEvent,
  | 'sourceType'
  | 'sourceId'
  | 'occurrenceKey'
  | 'scheduleRevision'
  | 'ruleId'
  | 'scheduledAt'
  | 'title'
  | 'message'
>;
type QuietHours = { enabled: boolean; start: string; end: string; timeZone: string } | null;
export type NotificationDomainPort = {
  prepare?(now: Date): void;
  due(now: Date): ReminderPlan[];
  events(): ReminderEvent[];
  valid(event: ReminderEvent): boolean;
  save(
    entity: Record<string, unknown>,
    requestId: string,
    expectedRevision?: string,
  ): ReminderEvent;
  quietHours(): QuietHours;
};
export type ToDooNotificationOptions = {
  db: AppDatabase;
  dataRoot: string;
  installationId: string;
  origin: string;
  network?: ToDooNetwork;
  now?: () => Date;
  restored?: boolean;
};
type LocalConfig = {
  installationId: string;
  origin: string;
  enabled: boolean;
  showContent: boolean;
  activatedAt: string | null;
  vapid: { publicKey: string; privateKey: string } | null;
};
type Device = {
  id: string;
  device_name: string;
  subscription: string;
  created_at: string;
  last_success_at: string | null;
  status: 'active' | 'expired';
};
type QueueRow = {
  id: string;
  event_id: string;
  generation: number;
  device_id: string;
  state: string;
  attempts: number;
  next_at: number;
  lease_until: number;
  payload: string | null;
};
export class ToDooNotificationError extends Error {
  statusCode = 400;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ToDooNotificationError';
    this.statusCode = statusCode;
  }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const reminderEventId = (plan: ReminderPlan) =>
  'rem_' +
  digest([
    plan.sourceType,
    plan.sourceId,
    plan.occurrenceKey,
    plan.scheduleRevision,
    plan.ruleId,
  ]).slice(0, 40);
function secureOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}
function localClock(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}
export function quietHoursEnd(at: Date, quiet: QuietHours): Date | null {
  if (
    !quiet?.enabled ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.start) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.end)
  )
    return null;
  const contains = (clock: string) =>
    quiet.start === quiet.end
      ? true
      : quiet.start < quiet.end
        ? clock >= quiet.start && clock < quiet.end
        : clock >= quiet.start || clock < quiet.end;
  if (!contains(localClock(at, quiet.timeZone))) return null;
  for (let minute = 1; minute <= 26 * 60; minute++) {
    const candidate = new Date(at.getTime() + minute * 60000);
    if (!contains(localClock(candidate, quiet.timeZone))) return candidate;
  }
  return new Date(at.getTime() + 24 * 3600000);
}
export function createToDooNotifications(
  serviceOrPort: ToDooService | NotificationDomainPort,
  options: ToDooNotificationOptions,
) {
  const db = options.db,
    network = options.network ?? createToDooNetwork(),
    now = options.now ?? (() => new Date());
  const port =
    'snapshot' in serviceOrPort ? notificationDomainPort(serviceOrPort, now) : serviceOrPort;
  db.exec(`CREATE TABLE IF NOT EXISTS to_doo_push_config(id INTEGER PRIMARY KEY CHECK(id=1),content TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS to_doo_push_devices(id TEXT PRIMARY KEY,endpoint_hash TEXT NOT NULL UNIQUE,device_name TEXT NOT NULL,subscription TEXT NOT NULL,created_at TEXT NOT NULL,last_success_at TEXT,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS to_doo_push_outbox(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,generation INTEGER NOT NULL,device_id TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,payload TEXT);
    CREATE INDEX IF NOT EXISTS to_doo_push_due ON to_doo_push_outbox(state,next_at);
    CREATE TABLE IF NOT EXISTS to_doo_reminder_event_actions(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,entity TEXT NOT NULL,expected_revision TEXT NOT NULL,response TEXT);
    CREATE TABLE IF NOT EXISTS to_doo_push_seen(event_id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(event_id,generation));`);
  const stored = db.prepare('SELECT content FROM to_doo_push_config WHERE id=1').get() as
    | { content: string }
    | undefined;
  let config: LocalConfig = stored
    ? JSON.parse(stored.content)
    : {
        installationId: options.installationId,
        origin: options.origin,
        enabled: false,
        showContent: false,
        activatedAt: null,
        vapid: null,
      };
  if (
    options.restored ||
    config.installationId !== options.installationId ||
    config.origin !== options.origin
  ) {
    config = {
      installationId: options.installationId,
      origin: options.origin,
      enabled: false,
      showContent: config.showContent,
      activatedAt: null,
      vapid: null,
    };
    db.exec(
      "DELETE FROM to_doo_push_devices;UPDATE to_doo_push_outbox SET state='cancelled',lease_until=0;",
    );
  }
  const persist = () =>
    db.prepare('INSERT OR REPLACE INTO to_doo_push_config VALUES(1,?)').run(JSON.stringify(config));
  persist();
  let timer: ReturnType<typeof setInterval> | null = null,
    processing: Promise<void> | null = null,
    closed = false,
    lastError: string | null = null;
  function status() {
    const devices = (
      db
        .prepare('SELECT id,device_name,created_at,last_success_at,status FROM to_doo_push_devices')
        .all() as Omit<Device, 'subscription'>[]
    ).map((device) => ({
      id: device.id,
      deviceName: device.device_name,
      createdAt: device.created_at,
      lastSuccessAt: device.last_success_at,
      status: device.status,
    }));
    const ready =
      config.enabled &&
      !!config.vapid &&
      secureOrigin(options.origin) &&
      devices.some((device) => device.status === 'active');
    const counts = db
      .prepare('SELECT state,COUNT(*) AS count FROM to_doo_push_outbox GROUP BY state')
      .all();
    return {
      enabled: config.enabled,
      ready,
      reason: !secureOrigin(options.origin)
        ? 'https_required'
        : !config.enabled
          ? 'host_inactive'
          : !config.vapid
            ? 'server_keys_missing'
            : devices.some((d) => d.status === 'active')
              ? 'ready'
              : 'device_subscription_required',
      publicKey: config.vapid?.publicKey ?? null,
      devices,
      showContent: config.showContent,
      logoutPolicy: 'devices_receive_until_revoked',
      outbox: counts,
      lastError,
    };
  }
  function deviceStatus(endpoint: string): {
    deviceId: string | null;
    status: 'active' | 'expired' | 'unregistered';
  } {
    const device = db
      .prepare('SELECT id,status FROM to_doo_push_devices WHERE endpoint_hash=?')
      .get(digest(endpoint)) as Pick<Device, 'id' | 'status'> | undefined;
    return device
      ? { deviceId: device.id, status: device.status }
      : { deviceId: null, status: 'unregistered' };
  }
  async function configure(input: { enabled: boolean; showContent?: boolean }) {
    if (typeof input.enabled !== 'boolean')
      throw new ToDooNotificationError('An explicit host activation choice is required');
    if (input.enabled && !secureOrigin(options.origin))
      throw new ToDooNotificationError('A secure application origin is required');
    if (input.enabled && !config.vapid) config.vapid = webPush.generateVAPIDKeys();
    if (input.enabled && !config.enabled) config.activatedAt = now().toISOString();
    config.enabled = input.enabled;
    if (input.showContent !== undefined) config.showContent = !!input.showContent;
    persist();
    return status();
  }
  async function subscribe(input: { subscription: webPush.PushSubscription; deviceName: string }) {
    if (!config.enabled || !config.vapid)
      throw new ToDooNotificationError('Activate this notification host first', 409);
    const subscription = input.subscription;
    if (
      !subscription ||
      typeof subscription.endpoint !== 'string' ||
      subscription.endpoint.length > 8192 ||
      !subscription.keys ||
      !['p256dh', 'auth'].every(
        (key) => typeof subscription.keys[key as keyof typeof subscription.keys] === 'string',
      )
    )
      throw new ToDooNotificationError('Invalid Push subscription');
    let url: URL;
    try {
      url = new URL(subscription.endpoint);
    } catch {
      throw new ToDooNotificationError('Invalid Push endpoint');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      url.hash
    )
      throw new ToDooNotificationError('Push endpoint requires controlled HTTPS on port 443');
    await network.validate(subscription.endpoint);
    if (
      Buffer.from(subscription.keys.p256dh, 'base64url').length !== 65 ||
      Buffer.from(subscription.keys.auth, 'base64url').length !== 16
    )
      throw new ToDooNotificationError('Invalid Push encryption keys');
    const endpointHash = digest(subscription.endpoint);
    const previous = db
      .prepare('SELECT id FROM to_doo_push_devices WHERE endpoint_hash=?')
      .get(endpointHash) as { id: string } | undefined;
    const id = previous?.id ?? randomUUID();
    db.prepare(
      'INSERT INTO to_doo_push_devices(id,endpoint_hash,device_name,subscription,created_at,status) VALUES(?,?,?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET device_name=excluded.device_name,subscription=excluded.subscription,status=excluded.status',
    ).run(
      id,
      endpointHash,
      String(input.deviceName ?? 'Device').slice(0, 100),
      JSON.stringify(subscription),
      now().toISOString(),
      'active',
    );
    return { id, status: 'active', publicKey: config.vapid.publicKey };
  }
  function revoke(id: string) {
    db.transaction(() => {
      db.prepare('DELETE FROM to_doo_push_devices WHERE id=?').run(id);
      db.prepare(
        "UPDATE to_doo_push_outbox SET state='cancelled',lease_until=0 WHERE device_id=? AND state NOT IN ('sent','expired')",
      ).run(id);
    })();
    return { revoked: true };
  }
  async function deliver(device: Device, payload: Record<string, unknown>): Promise<number> {
    if (!config.enabled || !config.vapid)
      throw new ToDooNotificationError('Notification host is inactive', 409);
    // Only build encryption/signature bytes with web-push. Its own HTTP client is never used.
    const details = webPush.generateRequestDetails(
      JSON.parse(device.subscription),
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: options.origin,
          publicKey: config.vapid.publicKey,
          privateKey: config.vapid.privateKey,
        },
        TTL: 300,
        urgency: 'normal',
      },
    );
    const headers = Object.fromEntries(
      Object.entries(details.headers).map(([name, value]) => [name, String(value)]),
    );
    const response = await network.request({
      url: details.endpoint,
      method: 'POST',
      headers,
      body: details.body ?? undefined,
      maxBytes: 65536,
      maxRedirects: 0,
    });
    if (response.status === 404 || response.status === 410)
      db.prepare("UPDATE to_doo_push_devices SET status='expired' WHERE id=?").run(device.id);
    if (response.status >= 200 && response.status < 300)
      db.prepare('UPDATE to_doo_push_devices SET last_success_at=? WHERE id=?').run(
        now().toISOString(),
        device.id,
      );
    return response.status;
  }
  async function test(id: string) {
    const device = db
      .prepare("SELECT * FROM to_doo_push_devices WHERE id=? AND status='active'")
      .get(id) as Device | undefined;
    if (!device) throw new ToDooNotificationError('Active device not found', 404);
    const code = await deliver(device, {
      title: 'To Doo 测试提醒',
      body: '测试已提交；设备是否显示取决于浏览器与系统。',
      tag: 'to-doo-test',
      url: '/?view=apps&app=to-doo&appSection=notifications',
      eventId: 'test',
    });
    if (code < 200 || code >= 300)
      throw new ToDooNotificationError(
        code === 404 || code === 410
          ? 'Push subscription expired'
          : 'Push service did not accept the test',
        502,
      );
    return { status: 'submitted_to_push_service', deviceId: id };
  }
  function action(
    id: string,
    input: {
      action: 'read' | 'acknowledge' | 'dismiss' | 'snooze';
      until?: string;
      requestId: string;
      expectedRevision: string;
    },
  ) {
    const datasetId =
      'snapshot' in serviceOrPort ? serviceOrPort.snapshot().datasetId : options.installationId;
    const requestKey = 'rem_event_' + digest([datasetId, input.requestId]).slice(0, 40);
    const fingerprint = digest([id, input.action, input.until ?? null, input.expectedRevision]);
    const previous = db
      .prepare(
        'SELECT fingerprint,entity,expected_revision,response FROM to_doo_reminder_event_actions WHERE request_id=?',
      )
      .get(requestKey) as
      | {
          fingerprint: string;
          entity: string;
          expected_revision: string;
          response: string | null;
        }
      | undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ToDooNotificationError('相同请求标识携带不同内容，请刷新后重试', 409);
      if (previous.response) return JSON.parse(previous.response) as ReminderEvent;
      const saved = port.save(JSON.parse(previous.entity), requestKey, previous.expected_revision);
      db.prepare('UPDATE to_doo_reminder_event_actions SET response=? WHERE request_id=?').run(
        JSON.stringify(saved),
        requestKey,
      );
      return saved;
    }
    const event = port.events().find((e) => e.id === id);
    if (!event) throw new ToDooNotificationError('Reminder not found', 404);
    if (!['read', 'acknowledge', 'dismiss', 'snooze'].includes(input.action))
      throw new ToDooNotificationError('Unknown reminder action');
    if (
      input.action === 'snooze' &&
      (!input.until ||
        !Number.isFinite(Date.parse(input.until)) ||
        Date.parse(input.until) <= now().getTime() ||
        Date.parse(input.until) > now().getTime() + 366 * 86400000)
    )
      throw new ToDooNotificationError('Choose a future snooze time within one year');
    const userState =
      input.action === 'acknowledge'
        ? 'acknowledged'
        : input.action === 'dismiss'
          ? 'dismissed'
          : input.action === 'snooze'
            ? 'snoozed'
            : 'read';
    const entity = {
      ...event,
      userState,
      snoozedUntil: input.action === 'snooze' ? input.until : null,
      deliveryGeneration:
        input.action === 'snooze' ? event.deliveryGeneration + 1 : event.deliveryGeneration,
    };
    db.prepare(
      'INSERT INTO to_doo_reminder_event_actions(request_id,fingerprint,entity,expected_revision) VALUES(?,?,?,?)',
    ).run(requestKey, fingerprint, JSON.stringify(entity), input.expectedRevision);
    const saved = port.save(entity, requestKey, input.expectedRevision);
    db.prepare('UPDATE to_doo_reminder_event_actions SET response=? WHERE request_id=?').run(
      JSON.stringify(saved),
      requestKey,
    );
    return saved;
  }
  async function run() {
    if (closed) return;
    const at = now(),
      atMs = at.getTime();
    port.prepare?.(at);
    const plans = port.due(at);
    const known = new Map(port.events().map((e) => [e.id, e]));
    for (const plan of plans) {
      if (Date.parse(plan.scheduledAt) > atMs) continue;
      const id = reminderEventId(plan);
      if (!known.has(id)) {
        const event = port.save(
          {
            ...plan,
            id,
            firstRaisedAt: at.toISOString(),
            userState: 'unread',
            snoozedUntil: null,
            deliveryGeneration: 0,
          },
          'raise_' + id,
        );
        known.set(id, event);
      }
    }
    const events = port.events();
    let missed: ReminderEvent[] = [];
    for (const event of events) {
      if (isHabitHistory(event)) continue;
      const valid =
        !event.deletedAt &&
        !['acknowledged', 'dismissed'].includes(event.userState) &&
        port.valid(event);
      if (!valid) {
        db.prepare(
          "UPDATE to_doo_push_outbox SET state='cancelled',lease_until=0 WHERE event_id=? AND state IN ('pending','sending')",
        ).run(event.id);
        continue;
      }
      db.prepare(
        "UPDATE to_doo_push_outbox SET state='cancelled',lease_until=0 WHERE event_id=? AND generation<>? AND state IN ('pending','sending')",
      ).run(event.id, event.deliveryGeneration);
      const scheduled = Date.parse(event.snoozedUntil ?? event.scheduledAt);
      if (scheduled > atMs) continue;
      if (!config.enabled) continue;
      if (event.deliveryGeneration === 0 && scheduled < atMs - 15 * 60000) {
        if (
          !db
            .prepare('SELECT 1 FROM to_doo_push_seen WHERE event_id=? AND generation=?')
            .get(event.id, event.deliveryGeneration)
        )
          missed.push(event);
        continue;
      }
      const seen = !!db
        .prepare('SELECT 1 FROM to_doo_push_seen WHERE event_id=? AND generation=?')
        .get(event.id, event.deliveryGeneration);
      // A portable event already raised elsewhere is not evidence that this host may replay it.
      if (
        !seen &&
        event.firstRaisedAt &&
        config.activatedAt &&
        event.firstRaisedAt < config.activatedAt &&
        event.deliveryGeneration === 0
      )
        continue;
      const deferred = quietHoursEnd(at, port.quietHours())?.getTime() ?? atMs;
      for (const device of db
        .prepare("SELECT * FROM to_doo_push_devices WHERE status='active'")
        .all() as Device[]) {
        db.prepare('INSERT OR IGNORE INTO to_doo_push_seen VALUES(?,?)').run(
          event.id,
          event.deliveryGeneration,
        );
        const id = event.id + ':' + event.deliveryGeneration + ':' + device.id;
        db.prepare(
          "INSERT OR IGNORE INTO to_doo_push_outbox(id,event_id,generation,device_id,state,next_at) VALUES(?,?,?,?,'pending',?)",
        ).run(id, event.id, event.deliveryGeneration, device.id, deferred);
      }
    }
    if (config.enabled && missed.length) {
      const key = 'missed_' + digest(missed.map((event) => event.id).sort()).slice(0, 32);
      for (const device of db
        .prepare("SELECT * FROM to_doo_push_devices WHERE status='active'")
        .all() as Device[]) {
        const event = missed[0];
        db.prepare(
          "INSERT OR IGNORE INTO to_doo_push_outbox(id,event_id,generation,device_id,state,next_at,payload) VALUES(?,?,0,?,'pending',?,?)",
        ).run(
          key + ':' + device.id,
          event.id,
          device.id,
          quietHoursEnd(at, port.quietHours())?.getTime() ?? atMs,
          JSON.stringify({
            summary: true,
            title: 'To Doo 有错过的提醒',
            body: `${missed.length} 项提醒可在站内中心查看`,
            tag: key,
            eventId: event.id,
            url: '/?view=apps&app=to-doo&appSection=notifications',
          }),
        );
      }
      if (db.prepare("SELECT 1 FROM to_doo_push_devices WHERE status='active' LIMIT 1").get())
        for (const event of missed)
          db.prepare('INSERT OR IGNORE INTO to_doo_push_seen VALUES(?,?)').run(
            event.id,
            event.deliveryGeneration,
          );
    }
    if (!config.enabled) return;
    const claimed = db.transaction(() => {
      const rows = db
        .prepare(
          "SELECT * FROM to_doo_push_outbox WHERE ((state='pending' AND next_at<=?) OR (state='sending' AND lease_until<=?)) ORDER BY next_at LIMIT 100",
        )
        .all(atMs, atMs) as QueueRow[];
      for (const row of rows)
        db.prepare("UPDATE to_doo_push_outbox SET state='sending',lease_until=? WHERE id=?").run(
          atMs + 60000,
          row.id,
        );
      return rows;
    })();
    for (const row of claimed) {
      if (closed) break;
      const event = port.events().find((e) => e.id === row.event_id),
        device = db
          .prepare("SELECT * FROM to_doo_push_devices WHERE id=? AND status='active'")
          .get(row.device_id) as Device | undefined;
      if (
        !event ||
        isHabitHistory(event) ||
        !device ||
        event.deletedAt ||
        ['acknowledged', 'dismissed'].includes(event.userState) ||
        !port.valid(event) ||
        (!row.payload && event.deliveryGeneration !== row.generation)
      ) {
        db.prepare("UPDATE to_doo_push_outbox SET state='cancelled',lease_until=0 WHERE id=?").run(
          row.id,
        );
        continue;
      }
      const quiet = quietHoursEnd(now(), port.quietHours());
      if (quiet) {
        db.prepare(
          "UPDATE to_doo_push_outbox SET state='pending',next_at=?,lease_until=0 WHERE id=?",
        ).run(quiet.getTime(), row.id);
        continue;
      }
      try {
        const payload = row.payload
          ? JSON.parse(row.payload)
          : {
              title: config.showContent ? event.title : 'To Doo 有一项提醒',
              body: config.showContent ? event.message : '打开 To Doo 查看',
              tag: event.id,
              eventId: event.id,
              generation: row.generation,
              url:
                '/?view=apps&app=to-doo&appSection=notifications' +
                (event.sourceType === 'task' ? '&task=' + encodeURIComponent(event.sourceId) : ''),
            };
        const code = await deliver(device, payload);
        if (code >= 200 && code < 300) {
          db.prepare(
            "UPDATE to_doo_push_outbox SET state='sent',lease_until=0,attempts=attempts+1 WHERE id=?",
          ).run(row.id);
          lastError = null;
        } else if (code === 404 || code === 410)
          db.prepare(
            "UPDATE to_doo_push_outbox SET state='expired',lease_until=0,attempts=attempts+1 WHERE id=?",
          ).run(row.id);
        else throw new Error('delivery failed');
      } catch {
        const attempts = row.attempts + 1;
        db.prepare(
          'UPDATE to_doo_push_outbox SET state=?,attempts=?,next_at=?,lease_until=0 WHERE id=?',
        ).run(
          attempts >= 5 ? 'failed' : 'pending',
          attempts,
          now().getTime() + Math.min(300000, 30000 * 2 ** (attempts - 1)),
          row.id,
        );
        lastError = 'Push delivery failed; retry status is available';
      }
    }
  }
  function process() {
    if (!processing)
      processing = run().finally(() => {
        processing = null;
      });
    return processing;
  }
  function start() {
    if (timer || closed) return;
    timer = setInterval(() => {
      void process().catch(() => {
        lastError = 'Reminder scheduling failed; data is preserved';
      });
    }, 15000);
    timer.unref();
    void process().catch(() => {
      lastError = 'Reminder scheduling failed; data is preserved';
    });
  }
  function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    return processing?.catch(() => {}) ?? Promise.resolve();
  }
  return {
    status,
    deviceStatus,
    configure,
    subscribe,
    revoke,
    test,
    action,
    process,
    start,
    close,
  };
}

const atZone = (value: ToDooDateTime, allDayTime = '09:00') => dateTimeInstant(value, allDayTime);
function habitDay(habit: ToDooEntityMap['habit'], at: Date) {
  let day = localDate(at, habit.timeZone);
  for (let i = 0; i < 3; i++) {
    const next = localDate(at, getHabitRule(habit, day).timeZone);
    if (next === day) break;
    day = next;
  }
  return day;
}
function habitSchedule(habit: ToDooEntityMap['habit'], day: string) {
  const period = getHabitPeriod(habit, day),
    rule = period.rule;
  return (
    'h_' +
    digest([
      rule.effectiveFrom,
      rule.frequency,
      rule.target,
      rule.timeZone,
      rule.weekdays,
      rule.startDate,
      rule.endDate,
      rule.weekStartsOn,
      rule.skipPolicy,
      period.start,
      period.endExclusive,
      period.scheduledDates,
      habit.reminders,
    ]).slice(0, 32)
  );
}
const anniversarySchedule = (anniversary: ToDooEntityMap['anniversary'], timeZone: string) =>
  'a_' +
  digest([
    anniversary.calendar,
    anniversary.date,
    anniversary.lunarLeapMonth,
    anniversary.repeatYearly,
    anniversary.leapPolicy,
    anniversary.reminders,
    timeZone,
  ]).slice(0, 32);
const isHabitHistory = (event: ReminderEvent) =>
  event.sourceType === 'habit' &&
  event.ruleId.startsWith('history_') &&
  event.occurrenceKey.startsWith('history:');

/** Check the original period and schedule, optionally retaining already achieved sources for a safe no-op completion. */
export function reminderSourceValid(
  state: ToDooSnapshot,
  event: ReminderEvent,
  at: Date,
  allowCompleted = false,
): boolean {
  if (event.deletedAt || reminderEventId(event) !== event.id) return false;
  if (event.sourceType === 'habit') {
    const habit = state.habits.find((h) => h.id === event.sourceId && !h.deletedAt);
    if (isHabitHistory(event)) return !!habit;
    if (!habit || !toDooDate.safeParse(event.occurrenceKey).success) return false;
    const period = summarizeHabitPeriod(habit, state.habitEntries, event.occurrenceKey);
    const rule = habit.reminders.find((r) => r.id === event.ruleId);
    if (!rule) return false;
    const anchor =
      rule.anchor === 'absolute' && rule.at
        ? new Date(rule.at)
        : atZone(
            { date: event.occurrenceKey, time: null, timeZone: period.rule.timeZone },
            rule.allDayTime,
          );
    return (
      Number.isFinite(anchor.getTime()) &&
      (rule.anchor !== 'absolute' ||
        localDate(anchor, period.rule.timeZone) === event.occurrenceKey) &&
      new Date(anchor.getTime() + rule.offsetMinutes * 60000).toISOString() === event.scheduledAt &&
      habitSchedule(habit, event.occurrenceKey) === event.scheduleRevision &&
      (period.status === 'pending' || (allowCompleted && period.status === 'achieved')) &&
      period.scheduledDates.includes(event.occurrenceKey) &&
      !state.habitEntries.some(
        (entry) =>
          entry.habitId === habit.id &&
          entry.localDate === event.occurrenceKey &&
          entry.skipped &&
          !entry.deletedAt,
      )
    );
  }
  if (event.sourceType === 'anniversary') {
    const anniversary = state.anniversaries.find((a) => a.id === event.sourceId && !a.deletedAt);
    if (!anniversary || !toDooDate.safeParse(event.occurrenceKey).success) return false;
    const rule = anniversary.reminders.find((r) => r.id === event.ruleId);
    if (
      !rule ||
      anniversarySchedule(anniversary, state.settings.timeZone) !== event.scheduleRevision
    )
      return false;
    try {
      if (nextAnniversary(anniversary, event.occurrenceKey).date !== event.occurrenceKey)
        return false;
      const anchor =
        rule.anchor === 'absolute' && rule.at
          ? new Date(rule.at)
          : atZone(
              { date: event.occurrenceKey, time: null, timeZone: state.settings.timeZone },
              rule.allDayTime,
            );
      return (
        new Date(anchor.getTime() + rule.offsetMinutes * 60000).toISOString() === event.scheduledAt
      );
    } catch {
      return false;
    }
  }
  const source = allowCompleted
    ? {
        ...state,
        occurrences: state.occurrences.map((o) =>
          o.taskId === event.sourceId && o.cycleKey === event.occurrenceKey && o.status === 'done'
            ? { ...o, status: 'todo' as const }
            : o,
        ),
      }
    : state;
  return notificationPlans(source, at).some(
    (plan) => reminderEventId(plan) === event.id && plan.scheduledAt === event.scheduledAt,
  );
}
export function backfillHabitReminders(
  service: ToDooService,
  at: Date,
  options: { days?: number } = {},
) {
  const snapshot = service.snapshot({ all: true }),
    days = Math.max(1, Math.min(options.days ?? 30, 90));
  let summaries = 0,
    coveredHabits = 0;
  for (const habit of snapshot.habits) {
    if (habit.deletedAt || !habit.reminders.length) continue;
    const today = habitDay(habit, at),
      yesterday = addDays(today, -1),
      lastRule = getHabitRule(habit, yesterday),
      through = lastRule.endDate && lastRule.endDate < yesterday ? lastRule.endDate : yesterday,
      firstStart = [habit.startDate, ...habit.ruleVersions.map((rule) => rule.startDate)].sort()[0];
    const previous = habit.reminderCheckpoint;
    if ((previous && previous.throughDate >= through) || firstStart > through) continue;
    const raised = snapshot.reminderEvents
      .filter(
        (event) =>
          event.sourceType === 'habit' &&
          event.sourceId === habit.id &&
          /^\d{4}-\d{2}-\d{2}$/.test(event.occurrenceKey) &&
          event.occurrenceKey < today &&
          event.firstRaisedAt,
      )
      .map((event) => event.occurrenceKey)
      .sort()
      .at(-1);
    const checkpoint = previous?.throughDate ?? raised;
    const requestedFrom = checkpoint ? addDays(checkpoint, 1) : firstStart;
    const lower = addDays(today, -days),
      from = [requestedFrom, firstStart, lower].sort().at(-1)!;
    if (from > through) continue;
    const uncoveredBefore = requestedFrom < lower ? lower : null;
    const missedPeriods = new Set<string>(),
      checkedPeriods = new Set<string>();
    let estimated = false;
    for (let day = from; day <= through; day = addDays(day, 1)) {
      const summary = summarizeHabitPeriod(habit, snapshot.habitEntries, day),
        historical = summary.rule;
      estimated ||= summary.estimated;
      checkedPeriods.add(habitSchedule(habit, day));
      if (
        summary.status !== 'pending' ||
        !summary.scheduledDates.includes(day) ||
        (historical.frequency !== 'daily' && summary.endExclusive > today) ||
        snapshot.habitEntries.some(
          (entry) =>
            entry.habitId === habit.id &&
            entry.localDate === day &&
            entry.skipped &&
            !entry.deletedAt,
        )
      )
        continue;
      const due = habit.reminders.some((rule) => {
        if (rule.anchor === 'absolute' && rule.at) {
          const instant = new Date(rule.at);
          return (
            localDate(instant, historical.timeZone) === day &&
            instant.getTime() + rule.offsetMinutes * 60000 <= at.getTime()
          );
        }
        return (
          atZone(
            { date: day, time: null, timeZone: historical.timeZone },
            rule.allDayTime,
          ).getTime() +
            rule.offsetMinutes * 60000 <=
          at.getTime()
        );
      });
      if (due)
        missedPeriods.add(
          summary.start + ':' + summary.endExclusive + ':' + habitSchedule(habit, day),
        );
    }
    const fingerprint = 'history_' + digest([...checkedPeriods].sort()).slice(0, 32),
      plan: ReminderPlan = {
        sourceType: 'habit',
        sourceId: habit.id,
        occurrenceKey: `history:${from}:${through}`,
        scheduleRevision: fingerprint,
        ruleId: 'history_' + digest([from, through, fingerprint]).slice(0, 32),
        scheduledAt: at.toISOString(),
        title: habit.name + ' · 错过提醒汇总',
        message:
          `${from} 至 ${through}：${estimated ? '含缺失历史版本，按当前可用规则估计' : '按历史生效规则核对'}，${missedPeriods.size} 个计划周期未达标。` +
          (estimated
            ? '历史版本不足部分不代表当时规则事实。'
            : '已按各周期累计、暂停与跳过口径核对。') +
          (uncoveredBefore
            ? `${requestedFrom} 至 ${addDays(lower, -1)} 超出 ${days} 日回填范围，未覆盖。`
            : ''),
      };
    const id = reminderEventId(plan),
      entities: {
        kind: 'habit' | 'reminderEvent';
        entity: Record<string, unknown>;
        expectedRevision?: string;
      }[] = [
        {
          kind: 'habit',
          entity: {
            ...habit,
            reminderCheckpoint: {
              throughDate: through,
              checkedAt: at.toISOString(),
              ruleFingerprint: fingerprint,
              coveredFrom: from,
              uncoveredBefore,
              estimated,
            },
          },
          expectedRevision: habit.revision,
        },
      ];
    if (
      (missedPeriods.size > 0 || uncoveredBefore) &&
      !snapshot.reminderEvents.some((event) => event.id === id)
    ) {
      entities.unshift({
        kind: 'reminderEvent',
        entity: {
          ...plan,
          id,
          firstRaisedAt: at.toISOString(),
          userState: 'unread',
          snoozedUntil: null,
          deliveryGeneration: 0,
        },
      });
      summaries++;
    }
    service.command({
      requestId:
        'habit_backfill_' + digest([habit.id, requestedFrom, through, fingerprint]).slice(0, 40),
      action: 'import_entities',
      payload: { entities },
    });
    coveredHabits++;
  }
  return { summaries, coveredHabits, days };
}
export function notificationPlans(snapshot: ToDooSnapshot, at: Date): ReminderPlan[] {
  const result: ReminderPlan[] = [];
  const tasks = new Map(
    snapshot.tasks.filter((t) => !t.deletedAt && !t.archivedAt).map((t) => [t.id, t]),
  );
  for (const occurrence of snapshot.occurrences) {
    const task = tasks.get(occurrence.taskId);
    if (
      !task ||
      occurrence.deletedAt ||
      ['done', 'cancelled', 'skipped'].includes(occurrence.status)
    )
      continue;
    for (const rule of occurrence.reminders ?? task.reminders) {
      let anchor: Date | null = null;
      if (rule.anchor === 'absolute' && rule.at) anchor = new Date(rule.at);
      else if (rule.anchor === 'due' && occurrence.due)
        anchor = atZone(occurrence.due, rule.allDayTime);
      else if (rule.anchor === 'plan') {
        const block = snapshot.timeBlocks
          .filter((b) => b.occurrenceId === occurrence.id && !b.deletedAt)
          .sort((a, b) =>
            (a.start.date + (a.start.time ?? '')).localeCompare(
              b.start.date + (b.start.time ?? ''),
            ),
          )[0];
        if (block) anchor = atZone(block.start, rule.allDayTime);
      } else if (rule.anchor === 'occurrence' && occurrence.scheduledDate)
        anchor = atZone(
          { date: occurrence.scheduledDate, time: null, timeZone: snapshot.settings.timeZone },
          rule.allDayTime,
        );
      if (anchor && Number.isFinite(anchor.getTime()))
        result.push({
          sourceType: 'task',
          sourceId: task.id,
          occurrenceKey: occurrence.cycleKey,
          scheduleRevision: occurrence.scheduleRevision,
          ruleId: rule.id,
          scheduledAt: new Date(anchor.getTime() + rule.offsetMinutes * 60000).toISOString(),
          title: occurrence.titleOverride ?? task.title,
          message: task.description.slice(0, 2000),
        });
    }
  }
  for (const habit of snapshot.habits) {
    if (habit.deletedAt) continue;
    const day = habitDay(habit, at),
      summary = summarizeHabitPeriod(habit, snapshot.habitEntries, day),
      historical = summary.rule;
    if (
      summary.status !== 'pending' ||
      !summary.scheduledDates.includes(day) ||
      snapshot.habitEntries.some(
        (entry) =>
          entry.habitId === habit.id &&
          entry.localDate === day &&
          entry.skipped &&
          !entry.deletedAt,
      )
    )
      continue;
    for (const rule of habit.reminders) {
      if (
        rule.anchor === 'absolute' &&
        rule.at &&
        localDate(new Date(rule.at), historical.timeZone) !== day
      )
        continue;
      const date =
        rule.anchor === 'absolute' && rule.at
          ? new Date(rule.at)
          : atZone({ date: day, time: null, timeZone: historical.timeZone }, rule.allDayTime);
      result.push({
        sourceType: 'habit',
        sourceId: habit.id,
        occurrenceKey: day,
        scheduleRevision: habitSchedule(habit, day),
        ruleId: rule.id,
        scheduledAt: new Date(date.getTime() + rule.offsetMinutes * 60000).toISOString(),
        title: habit.name,
        message: habit.description.slice(0, 2000),
      });
    }
  }
  for (const anniversary of snapshot.anniversaries) {
    if (anniversary.deletedAt || !anniversary.reminders.length) continue;
    const today = localDate(at, snapshot.settings.timeZone),
      offsets = anniversary.reminders.map((r) => r.offsetMinutes),
      earliest = addDays(today, -Math.ceil(Math.max(0, ...offsets) / 1440) - 30),
      latest = addDays(today, Math.ceil(Math.max(0, ...offsets.map((n) => -n)) / 1440) + 1);
    let cursor = earliest;
    for (let count = 0; count < 4; count++) {
      let date: string;
      try {
        date = nextAnniversary(anniversary, cursor).date;
      } catch {
        break;
      }
      if (date > latest) break;
      for (const rule of anniversary.reminders) {
        const anchor =
          rule.anchor === 'absolute' && rule.at
            ? new Date(rule.at)
            : atZone({ date, time: null, timeZone: snapshot.settings.timeZone }, rule.allDayTime);
        result.push({
          sourceType: 'anniversary',
          sourceId: anniversary.id,
          occurrenceKey: date,
          scheduleRevision: anniversarySchedule(anniversary, snapshot.settings.timeZone),
          ruleId: rule.id,
          scheduledAt: new Date(anchor.getTime() + rule.offsetMinutes * 60000).toISOString(),
          title: anniversary.name,
          message: anniversary.description.slice(0, 2000),
        });
      }
      if (!anniversary.repeatYearly) break;
      cursor = addDays(date, 1);
    }
  }
  return result;
}
export function notificationDomainPort(
  service: ToDooService,
  clock: () => Date = () => new Date(),
): NotificationDomainPort {
  const snapshot = () => service.snapshot({ all: true });
  const prepared = new Set<string>();
  return {
    prepare: (at) => {
      backfillHabitReminders(service, at);
      const state = snapshot(),
        tasks = new Map(state.tasks.map((task) => [task.id, task]));
      for (const task of state.tasks) {
        if (task.deletedAt || task.archivedAt || !task.reminders.length) continue;
        let parent = task,
          rule = task.recurrence;
        const seen = new Set<string>();
        while (!rule && parent.inheritRecurrence && parent.parentTaskId && !seen.has(parent.id)) {
          seen.add(parent.id);
          const ancestor = tasks.get(parent.parentTaskId);
          if (!ancestor) break;
          parent = ancestor;
          rule = parent.recurrence;
        }
        if (!rule) continue;
        const day = localDate(at, rule.timeZone),
          key = digest([task.id, rule.id, task.reminders, day]);
        if (prepared.has(key)) continue;
        const offsets = task.reminders.map((r) => r.offsetMinutes),
          from = addDays(day, -Math.ceil(Math.max(0, ...offsets) / 1440) - 30),
          to = addDays(day, Math.ceil(Math.max(0, ...offsets.map((n) => -n)) / 1440) + 1);
        service.command({
          requestId: 'rem_materialize_' + key.slice(0, 40),
          action: 'materialize_occurrences',
          payload: { taskId: task.id, from, to },
        });
        prepared.add(key);
      }
    },
    due: (at) => notificationPlans(snapshot(), at),
    events: () => snapshot().reminderEvents,
    quietHours: () => snapshot().settings.quietHours,
    valid: (event) => reminderSourceValid(snapshot(), event, clock()),
    save: (entity, requestId, expectedRevision) => {
      service.command({
        requestId,
        action: 'save_entity',
        payload: { kind: 'reminderEvent', entity, expectedRevision },
      });
      const event = snapshot().reminderEvents.find((e) => e.id === entity.id);
      if (!event)
        throw new ToDooNotificationError('Reminder persistence did not return the event', 500);
      return event;
    },
  };
}
export type ToDooNotifications = ReturnType<typeof createToDooNotifications>;
