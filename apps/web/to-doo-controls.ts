import {
  computed,
  inject,
  onScopeDispose,
  provide,
  shallowRef,
  type InjectionKey,
  type VNodeChild,
} from 'vue';

export type ToDooControlOption = {
  value?: unknown;
  label: unknown;
  disabled?: boolean;
  options?: ToDooControlOption[];
};
export type ToDooAntOption = {
  value?: string;
  label: any;
  disabled?: boolean;
  options?: ToDooAntOption[];
};
export function toDooSelectKey(value: unknown): string {
  return value === null ? 'null:' : typeof value + ':' + (JSON.stringify(value) ?? '');
}
function text(node: any): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node == null || typeof node === 'boolean') return '';
  return typeof node === 'object' ? text(node.children) : String(node);
}
/** Translate domain values into Ant keys, then recover the same typed values on selection. */
export function prepareToDooSelectOptions(nodes: VNodeChild[], supplied?: ToDooControlOption[]) {
  const values = new Map<string, unknown>();
  function fromOptions(options: ToDooControlOption[], disabled = false): ToDooAntOption[] {
    return options.map((option) => {
      if (option.options)
        return {
          label: option.label,
          options: fromOptions(option.options, disabled || !!option.disabled),
        };
      const key = toDooSelectKey(option.value);
      values.set(key, option.value);
      return { value: key, label: option.label, disabled: disabled || !!option.disabled };
    });
  }
  function fromNodes(items: any[], disabled = false): ToDooAntOption[] {
    return items.flatMap((node) => {
      if (!node || typeof node !== 'object') return [];
      if (Array.isArray(node)) return fromNodes(node, disabled);
      const props = node.props || {};
      const inactive = disabled || (props.disabled !== undefined && props.disabled !== false);
      if (node.type === 'optgroup')
        return [{ label: props.label, options: fromNodes(node.children || [], inactive) }];
      if (node.type === 'option') {
        const label = text(node.children);
        const value = Object.prototype.hasOwnProperty.call(props, 'value') ? props.value : label;
        const key = toDooSelectKey(value);
        values.set(key, value);
        return [{ value: key, label, disabled: inactive }];
      }
      return Array.isArray(node.children) ? fromNodes(node.children, disabled) : [];
    });
  }
  return { options: supplied ? fromOptions(supplied) : fromNodes(nodes), values };
}
export function normalizeToDooDateValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Picker text is not committed until accepted; keep the enclosing form's constraints active. */
export function validateToDooDateInput(
  value: string,
  options: { type?: string; required?: boolean; min?: string; max?: string },
): string {
  if (!value) return options.required ? '请选择日期或时间' : '';
  const normalized = value.replace(' ', 'T');
  const type = options.type || 'date';
  const date = normalized.slice(0, 10);
  const time = type === 'time' ? normalized : normalized.slice(11);
  if (
    type !== 'time' &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date)
  )
    return '请输入有效日期';
  if (
    type !== 'date' &&
    (!/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59)
  )
    return '请输入有效时间';
  const bounded = (bound: string) => (type !== 'time' && bound.length === 10 ? date : normalized);
  if (options.min && bounded(options.min) < options.min) return '不能早于 ' + options.min;
  if (options.max && bounded(options.max) > options.max) return '不能晚于 ' + options.max;
  return '';
}

type ConfirmOptions = { title?: string; danger?: boolean };
type ConfirmRequest = { content: string; title: string; danger: boolean };
type Confirm = (content: string, options?: ConfirmOptions) => Promise<boolean>;
export function createToDooConfirmation() {
  const request = shallowRef<ConfirmRequest | null>(null);
  let resolve: ((result: boolean) => void) | undefined;
  const ask: Confirm = (content, options = {}) => {
    if (resolve) return Promise.resolve(false);
    request.value = { content, title: options.title || '确认操作', danger: !!options.danger };
    return new Promise<boolean>((done) => {
      resolve = done;
    });
  };
  return {
    current: computed(() => request.value),
    ask,
    finish(accepted: boolean) {
      const done = resolve;
      resolve = undefined;
      request.value = null;
      done?.(accepted);
    },
  };
}
const confirmKey: InjectionKey<Confirm> = Symbol('to-doo.confirm');
export function provideToDooConfirm() {
  const confirmation = createToDooConfirmation();
  provide(confirmKey, confirmation.ask);
  onScopeDispose(() => confirmation.finish(false));
  return confirmation;
}
export function useToDooConfirm(): Confirm {
  return inject(confirmKey, async () => false);
}
