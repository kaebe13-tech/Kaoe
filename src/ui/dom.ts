type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** Tiny hyperscript helper: h('div.cls', {onclick}, children). */
export function h<K extends keyof HTMLElementTagNameMap>(tagSpec: K | `${K}.${string}`, attrs: Attrs = {}, children: Array<Node | string> | string = []): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = tagSpec.split('.') as [K, ...string[]];
  const el = document.createElement(tag);
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  if (typeof children === 'string') el.textContent = children;
  else for (const c of children) el.append(c);
  return el;
}

export function iconEl(svg: string, cls = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `icon ${cls}`.trim();
  s.innerHTML = svg;
  return s;
}

/** Set text only when it changed (avoids layout churn at UI refresh rate). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setHtml(el: HTMLElement, html: string): void {
  if ((el as HTMLElement & { _html?: string })._html !== html) {
    (el as HTMLElement & { _html?: string })._html = html;
    el.innerHTML = html;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}
