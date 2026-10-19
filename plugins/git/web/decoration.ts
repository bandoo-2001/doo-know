type Change = { path: string; code: string };

// Match the familiar light-theme Git colors used by code editors.
function status(code: string) {
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code))
    return { color: '#ad0707', title: '存在合并冲突', priority: 5 };
  if (code.includes('D')) return { color: '#ad0707', title: '文件已删除', priority: 4 };
  if (/[MT]/.test(code)) return { color: '#895503', title: '文件已修改', priority: 3 };
  if (/[RC]/.test(code)) return { color: '#6c6cc4', title: '文件已重命名或复制', priority: 2 };
  if (code === '??' || code.includes('A'))
    return {
      color: '#587c0c',
      title: code === '??' ? '新增文件，尚未纳入 Git 版本管理' : '新增文件，已暂存',
      priority: 1,
    };
  return { color: '#646464', title: '文件包含变更', priority: 0 };
}

export function gitDecoration(changes: Change[], path: string) {
  const direct = changes.find((change) => change.path === path);
  if (direct) return status(direct.code);
  const nested = changes.filter((change) => change.path.startsWith(path + '/'));
  if (!nested.length) return undefined;
  const highest = nested
    .map((change) => status(change.code))
    .reduce((a, b) => (a.priority >= b.priority ? a : b));
  return { ...highest, title: `目录包含变更：${highest.title}` };
}
