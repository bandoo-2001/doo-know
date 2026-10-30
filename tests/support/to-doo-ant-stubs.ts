import * as Vue from 'vue';

// Keep real business components and workbench state in renderer tests. These
// adapters replace browser-dependent controls at their public value/event edge.
const valueOf = (event: any) => (event?.target ? event.target.value : event);
const text = (value: any): string =>
  Array.isArray(value)
    ? value.map(text).join('')
    : value && typeof value === 'object'
      ? text(value.children)
      : value == null
        ? ''
        : String(value);

function input(tag: 'input' | 'textarea', numeric = false) {
  return Vue.defineComponent({
    inheritAttrs: false,
    props: ['value', 'disabled'],
    emits: ['update:value', 'input', 'change'],
    setup:
      (props, { attrs, emit }) =>
      () => {
        const next = (event: any) => {
          const raw = valueOf(event);
          return numeric ? (raw === '' || raw == null ? null : Number(raw)) : (raw ?? '');
        };
        return Vue.h(tag, {
          ...attrs,
          value: props.value,
          disabled: props.disabled,
          ...(numeric ? { type: 'number' } : {}),
          onInput: (event: any) => {
            emit('update:value', next(event));
            emit('input', event);
          },
          onChange: (event: any) => {
            emit('update:value', next(event));
            emit('change', numeric ? next(event) : event);
          },
        });
      },
  });
}

const Input = input('input');
const Textarea = input('textarea');
const InputNumber = input('input', true);
Object.assign(Input, { TextArea: Textarea });

function optionValues(nodes: any[]): unknown[] {
  return nodes.flatMap((node) => {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return optionValues(node);
    if (node.type === 'option')
      return [
        Object.prototype.hasOwnProperty.call(node.props || {}, 'value')
          ? node.props.value
          : text(node.children),
      ];
    return Array.isArray(node.children) ? optionValues(node.children) : [];
  });
}

function select(domain: boolean) {
  return Vue.defineComponent({
    inheritAttrs: false,
    props: ['value', 'modelValue', 'options', 'multiple', 'mode', 'disabled', 'placeholder'],
    emits: ['update:value', 'update:modelValue', 'change'],
    setup:
      (props, { attrs, slots, emit }) =>
      () => {
        const renderOptions = (options: any[]): Vue.VNode[] =>
          options.map((option) =>
            option.options
              ? Vue.h('optgroup', { label: option.label }, renderOptions(option.options))
              : Vue.h('option', { value: option.value, disabled: option.disabled }, option.label),
          );
        const children = props.options ? renderOptions(props.options) : slots.default?.() || [];
        const values = optionValues(children);
        const typed = (value: unknown): unknown => {
          const exact = values.findIndex((option) => Object.is(option, value));
          const index =
            exact >= 0 ? exact : values.findIndex((option) => String(option) === String(value));
          return index >= 0 ? values[index] : value;
        };
        const multiple = !!props.multiple || props.mode === 'multiple';
        return Vue.h(
          'select',
          {
            ...attrs,
            value: props.modelValue !== undefined ? props.modelValue : props.value,
            multiple,
            disabled: props.disabled,
            onChange: (event: any) => {
              const value = multiple
                ? Array.isArray(event)
                  ? event
                  : Array.from(event.target.selectedOptions).map((option: any) =>
                      typed(option._value !== undefined ? option._value : option.value),
                    )
                : typed(valueOf(event));
              emit('update:value', value);
              if (domain) emit('update:modelValue', value);
              emit('change', value);
            },
          },
          children,
        );
      },
  });
}

const Select = select(false);
export const ToDooSelectStub = select(true);
export const ToDooDateFieldStub = Vue.defineComponent({
  inheritAttrs: false,
  props: ['modelValue', 'value', 'type', 'disabled', 'required', 'min', 'max'],
  emits: ['update:modelValue', 'update:value', 'change', 'input'],
  setup:
    (props, { attrs, emit }) =>
    () => {
      const change = (event: any) => {
        const next = valueOf(event);
        const value = typeof next === 'string' ? next : '';
        emit('update:modelValue', value);
        emit('update:value', value);
        emit('change', value);
        emit('input', value);
      };
      return Vue.h('input', {
        ...attrs,
        type: props.type || 'date',
        value: props.modelValue !== undefined ? props.modelValue : props.value,
        disabled: props.disabled,
        required: props.required,
        min: props.min,
        max: props.max,
        onChange: change,
        onInput: change,
      });
    },
});

const Button = Vue.defineComponent({
  inheritAttrs: false,
  props: ['htmlType', 'type', 'disabled', 'loading'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      Vue.h(
        'button',
        {
          ...attrs,
          type: props.htmlType || 'button',
          disabled: !!props.disabled || !!props.loading,
        },
        [slots.icon?.(), slots.default?.()],
      ),
});
const checkboxGroup = Symbol('checkbox-group');
const Checkbox = Vue.defineComponent({
  inheritAttrs: false,
  props: ['checked', 'value', 'disabled'],
  emits: ['update:checked', 'change'],
  setup: (props, { attrs, slots, emit }) => {
    const group = Vue.inject<{
      value: () => any[];
      change: (value: any, checked: boolean) => void;
    } | null>(checkboxGroup, null);
    return () =>
      Vue.h('label', { class: attrs.class }, [
        Vue.h('input', {
          ...attrs,
          class: undefined,
          type: 'checkbox',
          value: props.value,
          disabled: props.disabled,
          checked: group ? group.value().includes(props.value) : props.checked,
          onChange: (event: any) => {
            const checked = !!event.target.checked;
            emit('update:checked', checked);
            emit('change', event);
            group?.change(props.value, checked);
          },
        }),
        slots.default?.(),
      ]);
  },
});
const CheckboxGroup = Vue.defineComponent({
  props: ['value', 'options', 'disabled'],
  emits: ['update:value', 'change'],
  setup: (props, { attrs, slots, emit }) => {
    const change = (value: any, checked: boolean) => {
      const next = checked
        ? [...(props.value || []), value]
        : (props.value || []).filter((item: any) => item !== value);
      emit('update:value', next);
      emit('change', next);
    };
    Vue.provide(checkboxGroup, { value: () => props.value || [], change });
    return () =>
      Vue.h(
        'div',
        attrs,
        props.options
          ? props.options.map((item: any) => {
              const option = typeof item === 'object' ? item : { value: item, label: item };
              return Vue.h(
                Checkbox,
                { value: option.value, disabled: props.disabled || option.disabled },
                { default: () => option.label },
              );
            })
          : slots.default?.(),
      );
  },
});
Object.assign(Checkbox, { Group: CheckboxGroup });

const Segmented = Vue.defineComponent({
  props: ['value', 'options', 'disabled'],
  emits: ['change', 'update:value'],
  setup:
    (props, { attrs, emit }) =>
    () =>
      Vue.h(
        'div',
        attrs,
        props.options.map((item: any) => {
          const option = typeof item === 'object' ? item : { value: item, label: item };
          return Vue.h(
            'button',
            {
              type: 'button',
              disabled: props.disabled || option.disabled,
              'aria-pressed': props.value === option.value,
              onClick: () => {
                emit('update:value', option.value);
                emit('change', option.value);
              },
            },
            option.label,
          );
        }),
      ),
});

const Modal = Vue.defineComponent({
  inheritAttrs: false,
  props: [
    'open',
    'title',
    'closable',
    'keyboard',
    'footer',
    'okText',
    'cancelText',
    'okButtonProps',
    'cancelButtonProps',
    'confirmLoading',
  ],
  emits: ['cancel', 'ok', 'update:open'],
  setup:
    (props, { attrs, slots, emit }) =>
    () =>
      props.open
        ? Vue.h(
            'section',
            {
              ...attrs,
              role: 'dialog',
              'aria-modal': true,
              'aria-label': attrs['aria-label'] || text(props.title || slots.title?.()),
              onKeydown: (event: any) => {
                if (event.key === 'Escape' && props.keyboard !== false) emit('cancel', event);
              },
            },
            [
              Vue.h('div', slots.title?.() || props.title),
              props.closable !== false
                ? Vue.h(
                    'button',
                    {
                      type: 'button',
                      'aria-label': 'Close',
                      onClick: (event: any) => emit('cancel', event),
                    },
                    '×',
                  )
                : null,
              slots.default?.(),
              slots.footer?.() ||
                (props.footer !== null
                  ? props.footer || [
                      Vue.h(
                        'button',
                        {
                          ...props.cancelButtonProps,
                          type: 'button',
                          onClick: (event: any) => emit('cancel', event),
                        },
                        props.cancelText || '取消',
                      ),
                      Vue.h(
                        'button',
                        {
                          ...props.okButtonProps,
                          type: 'button',
                          disabled: !!props.confirmLoading || props.okButtonProps?.disabled,
                          onClick: (event: any) => emit('ok', event),
                        },
                        props.okText || '确定',
                      ),
                    ]
                  : null),
            ],
          )
        : null,
});
const Drawer = Vue.defineComponent({
  props: ['open', 'title'],
  emits: ['close', 'update:open'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      props.open ? Vue.h('aside', attrs, [props.title, slots.default?.(), slots.footer?.()]) : null,
});
export const ToDooDisclosureStub = Vue.defineComponent({
  props: ['open', 'header'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      Vue.h('details', { ...attrs, open: !!props.open }, [
        Vue.h('summary', slots.header?.() || props.header),
        slots.default?.(),
      ]),
});
const CollapsePanel = ToDooDisclosureStub;
const Collapse = Vue.defineComponent({
  setup:
    (_, { attrs, slots }) =>
    () =>
      Vue.h('div', attrs, slots.default?.()),
});
Object.assign(Collapse, { Panel: CollapsePanel });
const Tag = Vue.defineComponent({
  setup:
    (_, { attrs, slots }) =>
    () =>
      Vue.h('span', attrs, slots.default?.()),
});
const Alert = Vue.defineComponent({
  props: ['message', 'description', 'type', 'showIcon'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      Vue.h('div', { role: 'alert', ...attrs }, [
        slots.message?.() || props.message,
        slots.description?.() || props.description,
        slots.default?.(),
      ]),
});
const Empty = Vue.defineComponent({
  props: ['description', 'image'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      Vue.h('div', attrs, [slots.description?.() || props.description, slots.default?.()]),
});
Object.assign(Empty, { PRESENTED_IMAGE_SIMPLE: 'simple' });
const Statistic = Vue.defineComponent({
  props: ['title', 'value', 'suffix', 'prefix'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      Vue.h('div', attrs, [
        slots.title?.() || props.title,
        slots.prefix?.() || props.prefix,
        String(props.value ?? ''),
        slots.suffix?.() || props.suffix,
      ]),
});
const Progress = Vue.defineComponent({
  props: ['percent'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      Vue.h(
        'div',
        {
          ...attrs,
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': props.percent,
        },
        slots.default?.(),
      ),
});
const Dropdown = Vue.defineComponent({
  setup:
    (_, { attrs, slots }) =>
    () =>
      Vue.h('details', attrs, [Vue.h('summary', slots.default?.()), slots.overlay?.()]),
});
const Popover = Vue.defineComponent({
  props: ['title'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      Vue.h('details', attrs, [
        Vue.h('summary', slots.default?.()),
        props.title,
        slots.content?.(),
      ]),
});
const Menu = Vue.defineComponent({
  setup:
    (_, { attrs, slots }) =>
    () =>
      Vue.h('div', { ...attrs, role: 'menu' }, slots.default?.()),
});
const MenuItem = Vue.defineComponent({
  setup:
    (_, { attrs, slots }) =>
    () =>
      Vue.h('button', { ...attrs, type: 'button', role: 'menuitem' }, slots.default?.()),
});

export const toDooAntStubs = {
  Input,
  Textarea,
  InputNumber,
  Select,
  Button,
  Checkbox,
  CheckboxGroup,
  Segmented,
  Modal,
  Drawer,
  Tag,
  Alert,
  Empty,
  Statistic,
  Progress,
  Collapse,
  CollapsePanel,
  Dropdown,
  Popover,
  Menu,
  MenuItem,
};

export function toDooBoundaryStub(path: string): Vue.Component | undefined {
  if (path.endsWith('ToDooSelect.vue')) return ToDooSelectStub;
  if (path.endsWith('ToDooDateField.vue')) return ToDooDateFieldStub;
  if (path.endsWith('ToDooDisclosure.vue')) return ToDooDisclosureStub;
}
