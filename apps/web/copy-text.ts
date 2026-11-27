/** Copy only from a user action. Plain HTTP on a LAN has no Clipboard API. */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }
  const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];
  const field =
    focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement ? focus : null;
  const start = field?.selectionStart;
  const end = field?.selectionEnd;
  const direction = field?.selectionDirection;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  (focus?.closest('[role="dialog"]') || document.body).append(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw Error('浏览器未能复制文本');
  } finally {
    textarea.value = '';
    textarea.remove();
    if (focus?.isConnected) focus.focus({ preventScroll: true });
    if (field?.isConnected && start != null && end != null) {
      field.setSelectionRange(start, end, direction ?? undefined);
    } else if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) {
        if (range.commonAncestorContainer.isConnected) selection.addRange(range);
      }
    }
  }
}
