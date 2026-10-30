import { describe, expect, test } from 'vitest';
import {
  enableCurrentToDooPushDevice,
  loadToDooPushStatus,
  type ToDooPushBrowserPort,
  type ToDooPushHost,
  type ToDooPushRegistration,
  type ToDooPushSubscription,
  type ToDooPushWorker,
} from '../apps/web/to-doo-push';

const host: ToDooPushHost = {
  enabled: true,
  ready: true,
  reason: 'ready',
  publicKey: 'AQID',
  showContent: false,
  devices: [{ id: 'other-device', deviceName: '其他浏览器', status: 'active' }],
};
const subscription: ToDooPushSubscription = {
  endpoint: 'https://push.example.test/private-device-token',
  toJSON: () => ({
    endpoint: 'https://push.example.test/private-device-token',
    keys: { p256dh: 'public-key', auth: 'auth-key' },
  }),
};
class Worker extends EventTarget implements ToDooPushWorker {
  state: ServiceWorkerState = 'installing';
}
function browserFixture(
  options: {
    permission?: NotificationPermission;
    subscription?: ToDooPushSubscription | null;
    installing?: boolean;
  } = {},
) {
  const effects: string[] = [];
  const worker = new Worker();
  worker.state = options.installing ? 'installing' : 'activated';
  let savedSubscription = options.subscription ?? null;
  const registration: ToDooPushRegistration = {
    active: options.installing ? null : worker,
    installing: options.installing ? worker : null,
    waiting: null,
    pushManager: {
      async getSubscription() {
        effects.push('read-subscription');
        return savedSubscription;
      },
      async subscribe(input) {
        expect(registration.active?.state).toBe('activated');
        expect(input.userVisibleOnly).toBe(true);
        expect([...new Uint8Array(input.applicationServerKey)]).toEqual([1, 2, 3]);
        effects.push('create-subscription');
        savedSubscription = subscription;
        return subscription;
      },
    },
  };
  const port: ToDooPushBrowserPort = {
    secureContext: true,
    supported: true,
    permission: () => options.permission ?? 'granted',
    requestPermission: async () => {
      effects.push('request-permission');
      return 'granted';
    },
    async getRegistration(script) {
      expect(script).toBe('/to-doo-sw.js');
      effects.push('find-registration');
      return registration;
    },
    async register(script) {
      expect(script).toBe('/to-doo-sw.js');
      effects.push('register-worker');
      return registration;
    },
    deviceName: '当前测试浏览器',
  };
  return { port, effects, registration, worker };
}

describe('current browser desktop reminder enrollment', () => {
  test('another active device does not make a browser without a subscription ready', async () => {
    const { port, effects } = browserFixture();
    const result = await loadToDooPushStatus(async (url) => {
      expect(url).toBe('/api/to-doo/push');
      return host;
    }, port);
    expect(result.currentDevice).toEqual({
      capability: 'supported',
      permission: 'granted',
      subscription: 'missing',
      deviceId: null,
      ready: false,
    });
    expect(effects).toEqual(['find-registration', 'read-subscription']);
  });

  test.each(['active', 'expired', 'unregistered'] as const)(
    'the current subscription is matched privately against its server status: %s',
    async (status) => {
      const { port } = browserFixture({ subscription });
      const result = await loadToDooPushStatus(async (url, method, body) => {
        if (url === '/api/to-doo/push') return host;
        expect([url, method, body]).toEqual([
          '/api/to-doo/push/device-status',
          'POST',
          { endpoint: subscription.endpoint },
        ]);
        return { deviceId: status === 'unregistered' ? null : 'current-device', status };
      }, port);
      expect(result.currentDevice.subscription).toBe(status);
      expect(result.currentDevice.ready).toBe(status === 'active');
      expect(result.currentDevice.deviceId).toBe(
        status === 'unregistered' ? null : 'current-device',
      );
      expect(JSON.stringify(result)).not.toContain(subscription.endpoint);
    },
  );

  test('denied permission is reported without prompting or touching the subscription', async () => {
    const { port, effects } = browserFixture({ permission: 'denied', subscription });
    const result = await loadToDooPushStatus(async () => host, port);
    expect(result.currentDevice.permission).toBe('denied');
    expect(result.currentDevice.ready).toBe(false);
    expect(effects).toEqual([]);
  });

  test.each([
    { secureContext: false, supported: true, capability: 'insecure' },
    { secureContext: true, supported: false, capability: 'unsupported' },
  ] as const)('unsupported environments remain read-only: $capability', async (options) => {
    const { port, effects } = browserFixture();
    const result = await loadToDooPushStatus(async () => host, { ...port, ...options });
    expect(result.currentDevice.capability).toBe(options.capability);
    expect(result.currentDevice.ready).toBe(false);
    expect(effects).toEqual([]);
  });

  test('an inactive host prevents readiness even when this subscription is active', async () => {
    const { port } = browserFixture({ subscription });
    const result = await loadToDooPushStatus(
      async (url) =>
        url === '/api/to-doo/push'
          ? { ...host, enabled: false, reason: 'host_inactive' }
          : { deviceId: 'current-device', status: 'active' },
      port,
    );
    expect(result.currentDevice.subscription).toBe('active');
    expect(result.currentDevice.ready).toBe(false);
  });

  test('a subscription lookup failure cannot reveal its endpoint in a UI error', async () => {
    const { port } = browserFixture({ subscription });
    await expect(
      loadToDooPushStatus(async (url) => {
        if (url === '/api/to-doo/push') return host;
        throw Error(subscription.endpoint);
      }, port),
    ).rejects.toThrow('无法检查当前设备订阅，请刷新重试');
  });
});

describe('explicit desktop reminder activation', () => {
  test('permission is requested synchronously from the user gesture, before activating the host', async () => {
    const { port, effects } = browserFixture({ permission: 'default', subscription });
    let resolvePermission!: (value: NotificationPermission) => void;
    port.requestPermission = () => {
      effects.push('request-permission');
      return new Promise((resolve) => {
        resolvePermission = resolve;
      });
    };
    const saved: unknown[] = [];
    const pending = enableCurrentToDooPushDevice(
      async (url, method, body) => {
        effects.push(url);
        if (url === '/api/to-doo/push/configure') {
          expect([method, body]).toEqual(['POST', { enabled: true, showContent: true }]);
          return { ...host, showContent: true };
        }
        saved.push(body);
      },
      { ...host, enabled: false, publicKey: null, showContent: true },
      port,
    );
    expect(effects).toEqual(['request-permission']);
    resolvePermission('granted');
    await pending;
    expect(saved).toEqual([{ subscription: subscription.toJSON(), deviceName: '当前测试浏览器' }]);
    expect(effects.indexOf('request-permission')).toBeLessThan(
      effects.indexOf('/api/to-doo/push/configure'),
    );
  });

  test('denying permission leaves the host and device enrollment untouched', async () => {
    const { port, effects } = browserFixture({ permission: 'default' });
    port.requestPermission = async () => 'denied';
    await expect(
      enableCurrentToDooPushDevice(
        async () => {
          throw Error('must not activate host');
        },
        { ...host, enabled: false },
        port,
      ),
    ).rejects.toThrow('尚未获得通知权限');
    expect(effects).toEqual([]);
  });

  test('a newly installed worker must activate before a browser subscription is created', async () => {
    const { port, effects, worker, registration } = browserFixture({ installing: true });
    const saved: unknown[] = [];
    const pending = enableCurrentToDooPushDevice(
      async (url, method, body) => {
        expect([url, method]).toEqual(['/api/to-doo/push/subscribe', 'POST']);
        saved.push(body);
      },
      host,
      port,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(effects).toEqual(['register-worker']);
    expect(saved).toEqual([]);
    registration.active = worker;
    registration.installing = null;
    worker.state = 'activated';
    worker.dispatchEvent(new Event('statechange'));
    await pending;
    expect(effects).toEqual(['register-worker', 'read-subscription', 'create-subscription']);
    expect(saved).toEqual([{ subscription: subscription.toJSON(), deviceName: '当前测试浏览器' }]);
  });

  test('an existing browser subscription is saved again after server-side revocation', async () => {
    const { port, effects } = browserFixture({ subscription });
    let enrolled = false;
    const request = async (url: string, method?: string, body?: unknown) => {
      if (url === '/api/to-doo/push') return host;
      if (url === '/api/to-doo/push/device-status')
        return {
          deviceId: enrolled ? 'restored-device' : null,
          status: enrolled ? 'active' : 'unregistered',
        };
      expect([url, method, body]).toEqual([
        '/api/to-doo/push/subscribe',
        'POST',
        {
          subscription: subscription.toJSON(),
          deviceName: '当前测试浏览器',
        },
      ]);
      enrolled = true;
    };
    expect((await loadToDooPushStatus(request, port)).currentDevice.ready).toBe(false);
    await enableCurrentToDooPushDevice(request, host, port);
    expect((await loadToDooPushStatus(request, port)).currentDevice).toMatchObject({
      ready: true,
      deviceId: 'restored-device',
      subscription: 'active',
    });
    expect(effects).not.toContain('create-subscription');
    expect(effects).not.toContain('request-permission');
  });
});
