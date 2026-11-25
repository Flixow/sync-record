const TEXT_INPUTS = new Set(["text", "search", "number", "email", "url", "tel", "password"]);

/** True while the user types somewhere, where the editing shortcuts must leave the keys alone. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type);
}

/** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo; anything else (and any key while typing) is null. */
export function historyKey(event: KeyboardEvent): "undo" | "redo" | null {
  if (isTyping(event.target)) return null;
  if (!(event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y") return "redo";
  return null;
}
