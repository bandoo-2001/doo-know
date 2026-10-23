export function handleSaveShortcut(event: KeyboardEvent, save: () => void) {
  if (event.defaultPrevented || event.shiftKey || event.altKey) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save();
  }
}
