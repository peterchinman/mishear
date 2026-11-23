/** Start the clipboard write directly from the click so Safari can use the user gesture. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Unavailable or denied in this browser context.
  }
  return copyUsingSelection(text);
}

/** A best-effort copy for browsers and HTTP previews without clipboard access. */
function copyUsingSelection(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;

  const focused = document.activeElement;
  const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
  const start = input?.selectionStart;
  const end = input?.selectionEnd;
  const direction = input?.selectionDirection ?? undefined;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];

  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.tabIndex = -1;
  field.setAttribute('aria-label', 'Clipboard text');
  // Keep it selectable without triggering the mobile keyboard, zoom, or page scroll.
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;pointer-events:none';
  document.body.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
    if (input && start != null && end != null) input.setSelectionRange(start, end, direction);
  }
}
