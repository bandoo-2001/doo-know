import type { ToDooRequest } from './to-doo-workbench';

export type ToDooPushHost = {
  enabled: boolean;
  ready: boolean;
  reason: string;
  publicKey: string | null;
  showContent: boolean;
  devices: {
    id: string;
    deviceName: string;
    status: 'active' | 'expired';
    lastSuccessAt?: string | null;
  }[];
  lastError?: string | null;
};
export type ToDooCurrentPushDevice = {
  capability: 'supported' | 'insecure' | 'unsupported';
  permission: NotificationPermission | 'unsupported';
  subscription: 'missing' | 'active' | 'expired' | 'unregistered';
  deviceId: string | null;
  ready: boolean;
};
export type ToDooPushSubscription = {
  endpoint: string;
  toJSON(): unknown;
};
export type ToDooPushWorker = {
  state: ServiceWorkerState;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
};
export type ToDooPushRegistration = {
  active: ToDooPushWorker | null;
  installing: ToDooPushWorker | null;
  waiting: ToDooPushWorker | null;
  pushManager: {
    getSubscription(): Promise<ToDooPushSubscription | null>;
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: ArrayBuffer;
    }): Promise<ToDooPushSubscription>;
  };
};
export type ToDooPushBrowserPort = {
  secureContext: boolean;
  supported: boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  getRegistration(script: string): Promise<ToDooPushRegistration | undefined>;
  register(script: string): Promise<ToDooPushRegistration>;
  deviceName: string;
};

function currentBrowser(): ToDooPushBrowserPort {
  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
  return {
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
    supported,
    permission: () => (supported ? Notification.permission : 'default'),
    requestPermission: () => Notification.requestPermission(),
    getRegistration: (script) => navigator.serviceWorker.getRegistration(script),
    register: (script) => navigator.serviceWorker.register(script),
    deviceName:
      typeof navigator === 'undefined' ? '当前浏览器' : navigator.platform || '当前浏览器',
  };
}

/** Read only: inspecting settings never prompts, registers a worker, or activates a host. */
export async function loadToDooPushStatus(
  request: ToDooRequest,
  browser: ToDooPushBrowserPort = currentBrowser(),
): Promise<{ host: ToDooPushHost; currentDevice: ToDooCurrentPushDevice }> {
  const host: ToDooPushHost = await request('/api/to-doo/push');
  const currentDevice: ToDooCurrentPushDevice = {
    capability: !browser.secureContext
      ? 'insecure'
      : browser.supported
        ? 'supported'
        : 'unsupported',
    permission: browser.supported ? browser.permission() : 'unsupported',
    subscription: 'missing',
    deviceId: null,
    ready: false,
  };
  if (currentDevice.capability !== 'supported' || currentDevice.permission !== 'granted')
    return { host, currentDevice };
  try {
    const registration = await browser.getRegistration('/to-doo-sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return { host, currentDevice };
    const device: { deviceId: string | null; status: 'active' | 'expired' | 'unregistered' } =
      await request('/api/to-doo/push/device-status', 'POST', { endpoint: subscription.endpoint });
    currentDevice.subscription = device.status;
    currentDevice.deviceId = device.deviceId;
    currentDevice.ready =
      host.enabled &&
      !!host.publicKey &&
      ['ready', 'device_subscription_required'].includes(host.reason) &&
      device.status === 'active';
    return { host, currentDevice };
  } catch {
    // Endpoints are credentials; never forward browser/network errors containing one to the UI.
    throw Error('无法检查当前设备订阅，请刷新重试');
  }
}

function waitForActiveWorker(registration: ToDooPushRegistration): Promise<void> {
  if (registration.active?.state === 'activated') return Promise.resolve();
  const workers = [registration.installing, registration.waiting, registration.active].filter(
    (worker): worker is ToDooPushWorker => !!worker,
  );
  if (!workers.length) return Promise.reject(Error('后台通知组件尚未就绪，请稍后重试'));
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      workers.forEach((worker) => worker.removeEventListener('statechange', check));
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (registration.active?.state === 'activated') finish();
      else if (workers.every((worker) => worker.state === 'redundant'))
        finish(Error('后台通知组件安装失败，请刷新后重试'));
    };
    const timer = setTimeout(() => finish(Error('后台通知组件尚未就绪，请稍后重试')), 15000);
    workers.forEach((worker) => worker.addEventListener('statechange', check));
    check();
  });
}

/** Call directly from a click handler so permission is requested before any asynchronous work. */
export async function enableCurrentToDooPushDevice(
  request: ToDooRequest,
  host: ToDooPushHost,
  browser: ToDooPushBrowserPort = currentBrowser(),
): Promise<void> {
  if (!browser.secureContext || !browser.supported)
    throw Error('当前浏览器或站点地址不支持桌面提醒');
  const existingPermission = browser.permission();
  const permission =
    existingPermission === 'default' ? await browser.requestPermission() : existingPermission;
  if (permission !== 'granted')
    throw Error('尚未获得通知权限，请在浏览器的站点设置中允许通知后重试');
  if (!host.enabled || !host.publicKey)
    host = await request('/api/to-doo/push/configure', 'POST', {
      enabled: true,
      showContent: host.showContent,
    });
  if (!host.publicKey) throw Error('服务尚未准备好推送密钥，请稍后重试');
  try {
    const registration = await browser.register('/to-doo-sw.js');
    await waitForActiveWorker(registration);
    const publicKey = host.publicKey.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(publicKey.padEnd(Math.ceil(publicKey.length / 4) * 4, '='));
    const key = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    const subscription =
      (await registration.pushManager.getSubscription()) ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key.buffer,
      }));
    // Persist an existing subscription too: the host may have revoked or lost its record.
    await request('/api/to-doo/push/subscribe', 'POST', {
      subscription: subscription.toJSON(),
      deviceName: browser.deviceName.slice(0, 100) || '当前浏览器',
    });
  } catch {
    throw Error('当前设备桌面提醒启用未完成，请检查浏览器通知设置后重试');
  }
}
