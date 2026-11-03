import type { MindElixirInstance, Topic } from 'mind-elixir';
import './mindmap-controls.css';

/** Only expose operations representable by the plain-text Markdown outline. */
export function installMindmapControls(mind: MindElixirInstance) {
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const toolbar = document.createElement('div');
  toolbar.className = 'mindmap-controls';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '脑图操作');
  const menu = document.createElement('div');
  menu.className = 'mindmap-popup mindmap-node-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '脑图节点操作');
  menu.hidden = true;
  const help = document.createElement('div');
  help.className = 'mindmap-popup mindmap-shortcuts';
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-label', '脑图快捷键');
  help.hidden = true;
  let returnFocus: HTMLElement | undefined;
  let disposed = false;

  function button(text: string, label = text) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.setAttribute('aria-label', label);
    return element;
  }
  const actionsTrigger = button('节点操作', '脑图节点操作');
  const helpTrigger = button('快捷键', '脑图快捷键');
  actionsTrigger.setAttribute('aria-haspopup', 'menu');
  helpTrigger.setAttribute('aria-haspopup', 'dialog');
  toolbar.append(actionsTrigger, helpTrigger);

  function close(restoreFocus = false) {
    menu.hidden = help.hidden = true;
    actionsTrigger.setAttribute('aria-expanded', 'false');
    helpTrigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) returnFocus?.focus({ preventScroll: true });
  }
  function position(popup: HTMLElement, x: number, y: number) {
    const rect = mind.container.getBoundingClientRect();
    popup.style.left =
      Math.max(8, Math.min(x - rect.left, rect.width - popup.offsetWidth - 8)) + 'px';
    popup.style.top =
      Math.max(8, Math.min(y - rect.top, rect.height - popup.offsetHeight - 8)) + 'px';
  }
  const actions: {
    label: string;
    key?: string;
    rootAllowed?: boolean;
    disabled?: (node: Topic) => boolean;
    run: (node: Topic) => unknown;
  }[] = [
    { label: '编辑文字', key: 'F2', rootAllowed: true, run: (node) => mind.beginEdit(node) },
    { label: '新增子节点', key: 'Tab', rootAllowed: true, run: (node) => mind.addChild(node) },
    { label: '新增同级节点', key: 'Enter', run: (node) => mind.insertSibling('after', node) },
    { label: '插入父节点', key: modifier + '+Enter', run: (node) => mind.insertParent(node) },
    {
      label: '上移节点',
      key: 'Alt+↑',
      disabled: (node) => node.nodeObj.parent?.children?.[0] === node.nodeObj,
      run: (node) => mind.moveUpNode(node),
    },
    {
      label: '下移节点',
      key: 'Alt+↓',
      disabled: (node) => node.nodeObj.parent?.children?.at(-1) === node.nodeObj,
      run: (node) => mind.moveDownNode(node),
    },
    {
      label: '展开 / 收起分支',
      disabled: (node) => !node.nodeObj.children?.length,
      run: (node) => mind.expandNode(node),
    },
    { label: '删除节点', key: 'Delete', run: (node) => mind.removeNodes([node]) },
  ];
  function showMenu(node: Topic, x: number, y: number, trigger: HTMLElement) {
    close();
    mind.selectNode(node);
    returnFocus = trigger;
    menu.replaceChildren();
    const title = document.createElement('div');
    title.className = 'mindmap-menu-title';
    title.textContent = node.nodeObj.topic;
    title.title = node.nodeObj.topic;
    menu.append(title);
    for (const action of actions) {
      const item = button(action.label);
      // The visible shortcut forms part of the accessible name, just like a desktop menu.
      item.removeAttribute('aria-label');
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
      const shortcut = document.createElement('kbd');
      shortcut.textContent = action.key || '';
      item.append(shortcut);
      item.disabled =
        (!action.rootAllowed && node.nodeObj.id === mind.nodeData.id) || !!action.disabled?.(node);
      if (action.label === '删除节点') item.className = 'mindmap-danger';
      item.onclick = () => {
        close();
        mind.container.focus({ preventScroll: true });
        void action.run(node);
      };
      menu.append(item);
    }
    menu.hidden = false;
    actionsTrigger.setAttribute('aria-expanded', 'true');
    position(menu, x, y);
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  function contextMenu(event: MouseEvent) {
    const node = event.target instanceof Element ? event.target.closest<Topic>('me-tpc') : null;
    if (node?.nodeObj && node.id !== 'input-box' && mind.container.contains(node))
      showMenu(node, event.clientX, event.clientY, mind.container);
  }
  actionsTrigger.onclick = () => {
    if (!menu.hidden) {
      close(true);
      return;
    }
    const node = mind.currentNode || mind.container.querySelector<Topic>('me-root me-tpc');
    if (!node) return;
    const rect = actionsTrigger.getBoundingClientRect();
    showMenu(node, rect.left, rect.bottom + 6, actionsTrigger);
  };
  const heading = document.createElement('strong');
  heading.textContent = '脑图快捷键';
  const dismiss = button('×', '关闭快捷键');
  dismiss.className = 'mindmap-help-close';
  dismiss.onclick = () => close(true);
  const intro = document.createElement('p');
  intro.textContent = '先选中节点，再使用快捷键。双击节点也可编辑文字。';
  help.append(heading, dismiss, intro);
  const shortcuts = [
    ...actions.filter((action) => action.key).map((action) => [action.label, action.key!]),
    ['选择相邻节点', '↑ ↓ ← →'],
    ['撤销', modifier + '+Z'],
    ['重做', modifier + '+Shift+Z'],
    ['全图居中', 'F1'],
    ['打开节点菜单', 'Shift+F10'],
    ['保存文档', modifier + '+S'],
  ];
  for (const [label, key] of shortcuts) {
    const row = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = label;
    const shortcut = document.createElement('kbd');
    shortcut.textContent = key;
    row.append(name, shortcut);
    help.append(row);
  }
  helpTrigger.onclick = () => {
    if (!help.hidden) {
      close(true);
      return;
    }
    close();
    returnFocus = helpTrigger;
    help.hidden = false;
    helpTrigger.setAttribute('aria-expanded', 'true');
    const rect = helpTrigger.getBoundingClientRect();
    position(help, rect.right - help.offsetWidth, rect.bottom + 6);
    dismiss.focus({ preventScroll: true });
  };
  function keydown(event: KeyboardEvent) {
    if ((event.target as Element).closest('#input-box')) return;
    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const node = mind.currentNode;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      showMenu(node, rect.left, rect.bottom, mind.container);
    }
  }
  function popupKeydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab' && !menu.hidden) {
      close(true);
      return;
    }
    if (menu.hidden || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  }
  function outside(event: Event) {
    if (![toolbar, menu, help].some((element) => element.contains(event.target as Node))) close();
  }
  const stop = (event: Event) => event.stopPropagation();
  for (const element of [toolbar, menu, help]) {
    element.addEventListener('pointerdown', stop);
    element.addEventListener('click', stop);
    element.addEventListener('keydown', popupKeydown);
  }
  mind.container.append(toolbar, menu, help);
  close();
  mind.bus.addListener('showContextMenu', contextMenu);
  mind.container.addEventListener('keydown', keydown, true);
  document.addEventListener('pointerdown', outside, true);
  const resize = () => close();
  window.addEventListener('resize', resize);
  return () => {
    if (disposed) return;
    disposed = true;
    mind.bus.removeListener('showContextMenu', contextMenu);
    mind.container.removeEventListener('keydown', keydown, true);
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', resize);
    toolbar.remove();
    menu.remove();
    help.remove();
  };
}
