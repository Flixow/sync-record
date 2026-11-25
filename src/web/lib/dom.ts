type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | number | EventListener | undefined>;

/** Minimal element builder: h("button", { class: "btn", onclick: fn }, "Label"). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else if (key === "class") {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function setChildren(el: Element, ...children: Child[]): void {
  clear(el);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
}
