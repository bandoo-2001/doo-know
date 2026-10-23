export type UploadItem<T, R> = {
  id: string;
  requestId: string;
  data: T;
  state: 'queued' | 'uploading' | 'succeeded' | 'failed' | 'cancelled';
  result?: R;
  error?: string;
};
export function createUploadQueue<T, R>(
  upload: (item: UploadItem<T, R>) => Promise<R>,
  changed: () => void = () => {},
) {
  const items: UploadItem<T, R>[] = [];
  let active: Promise<void> | undefined;
  return {
    items,
    add(data: readonly T[]) {
      const added = data.map((value) => ({
        id: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        data: value,
        state: 'queued' as const,
      }));
      items.push(...added);
      changed();
      return added;
    },
    retry(id: string) {
      const item = items.find((x) => x.id === id);
      if (item && (item.state === 'failed' || item.state === 'cancelled')) {
        item.state = 'queued';
        item.error = undefined;
        changed();
      }
    },
    cancel(id: string) {
      const item = items.find((x) => x.id === id);
      if (item && item.state !== 'succeeded') {
        item.state = 'cancelled';
        changed();
      }
    },
    results() {
      return items.filter((x) => x.state === 'succeeded').map((x) => x.result!);
    },
    run(): Promise<void> {
      if (active) return active;
      active = Promise.resolve()
        .then(async () => {
          for (const item of items) {
            if (item.state !== 'queued') continue;
            item.state = 'uploading';
            changed();
            try {
              const result = await upload(item);
              if ((item.state as string) !== 'cancelled') {
                item.result = result;
                item.state = 'succeeded';
              }
            } catch (cause) {
              if ((item.state as string) !== 'cancelled') {
                item.error = cause instanceof Error ? cause.message : String(cause);
                item.state = 'failed';
              }
            }
            changed();
          }
        })
        .finally(() => {
          active = undefined;
          changed();
        });
      return active;
    },
  };
}
