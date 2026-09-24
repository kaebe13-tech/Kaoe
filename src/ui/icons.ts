/** Inline SVG icons (24x24), shared by all UI. Stroke uses currentColor. */
const S = (body: string, fill = false) =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  food: S('<circle cx="8" cy="15" r="3.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="3.2" fill="currentColor"/><circle cx="12" cy="9.5" r="3.2" fill="currentColor"/><path d="M12 6c0-2 1.5-3 3-3.5"/>'),
  water: S('<path d="M12 3c3 4.5 6 7.8 6 11a6 6 0 0 1-12 0c0-3.2 3-6.5 6-11z" fill="currentColor" stroke="none"/><path d="M9.5 15a2.8 2.8 0 0 0 2.5 2.6" stroke="rgba(0,0,0,.35)"/>'),
  sleep: S('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="currentColor" stroke="none"/>'),
  warning: S('<path d="M12 3 2.5 20h19z" fill="currentColor" stroke="none"/><path d="M12 9v5M12 17.2v.3" stroke="#1a1f24" stroke-width="2.4"/>'),
  rain: S('<path d="M7 15a4.5 4.5 0 1 1 .8-8.9A5.5 5.5 0 0 1 18.4 8 3.5 3.5 0 0 1 18 15z" fill="currentColor" stroke="none"/><path d="M8 18l-1 2.5M12.5 18l-1 2.5M17 18l-1 2.5"/>'),
  home: S('<path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9.5h13V10" /><path d="M10 19.5v-5h4v5"/>'),
  heart: S('<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" fill="currentColor" stroke="none"/>'),
  social: S('<path d="M4 5h11v7H9l-3.5 3v-3H4z" fill="currentColor" stroke="none"/><path d="M17 9h3v7h-1.5v2.5L15.5 16H11v-2"/>'),
  build: S('<path d="M4 20h16"/><path d="M6 20V9l6-5 6 5v11"/><path d="M9.5 20v-6h5v6"/>'),
  wood: S('<rect x="3" y="7" width="15" height="10" rx="5" fill="currentColor" stroke="none"/><ellipse cx="18" cy="12" rx="3" ry="5"/><path d="M17 12h2"/>'),
  hammer: S('<path d="M14.5 4.5 19.5 9.5 17 12l-5-5z" fill="currentColor" stroke="none"/><path d="M13.5 10.5 5 19"/>'),
  fire: S('<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.4-5.5 3.6-8.3.5 1.8 1.4 2.9 2.4 3.4.3-2.8 1.8-5 3.4-6.4 0 3.2 3.6 5.8 3.6 11.2 0 3.6-2.6 6.3-6.5 6.3z" fill="currentColor" stroke="none"/>'),
  explore: S('<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5z" fill="currentColor"/>'),
  idle: S('<path d="M5 19c9 0 14-5 14-14C10 5 5 10 5 19z" fill="currentColor" stroke="none"/><path d="M5 19 13 11" stroke="rgba(0,0,0,.3)"/>'),
  star: S('<path d="m12 3 2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 17l-5.6 3 1.3-6.2L3 9.5l6.3-.7z" fill="currentColor" stroke="none"/>'),
  heal: S('<path d="M9 3.5h6v5.5h5.5v6H15v5.5H9V15H3.5V9H9z" fill="currentColor" stroke="none"/>'),
  lightning: S('<path d="M13.5 2 5 13.5h6L9.5 22 19 9.8h-6.2z" fill="currentColor" stroke="none"/>'),
  bless: S('<path d="M12 21v-8"/><path d="M12 13c-4 0-6.5-2.8-6.5-6.5C9.5 6.5 12 9 12 13z" fill="currentColor"/><path d="M12 11c0-3.6 2.4-6 6.5-6 0 3.7-2.5 6-6.5 6z" fill="currentColor"/>'),
  select: S('<path d="M6 3.5 18 12l-5.4 1.3L16 19.8l-2.6 1.4-3.3-6.4L6 18.6z" fill="currentColor" stroke-width="1.4"/>'),
  pause: S('<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>'),
  play: S('<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>'),
  menu: S('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: S('<path d="M6 6l12 12M18 6 6 18"/>'),
  follow: S('<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="7.5"/>'),
  people: S('<circle cx="9" cy="8" r="3.2" fill="currentColor" stroke="none"/><path d="M3 20c0-3.8 2.7-6.5 6-6.5s6 2.7 6 6.5z" fill="currentColor" stroke="none"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 13.7c2.8.3 4.5 2.6 4.5 5.8"/>'),
  sun: S('<circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>'),
  moon: S('<path d="M19.5 15.2A8 8 0 1 1 8.8 4.5a6.4 6.4 0 0 0 10.7 10.7z" fill="currentColor" stroke="none"/>'),
  save: S('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><rect x="8" y="13" width="8" height="5" rx="1"/>'),
  load: S('<path d="M4 7h6l2 2h8v10H4z"/><path d="M12 16v-5M9.5 13.5 12 11l2.5 2.5"/>'),
  globe: S('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>'),
  sound: S('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  mute: S('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
  keyboard: S('<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17.5 10.5h.01M7.5 14h9"/>'),
  info: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2" stroke-width="2.4"/>'),
  bug: S('<rect x="8" y="7" width="8" height="12" rx="4" fill="currentColor" stroke="none"/><path d="M12 7V5M8 11H4.5M16 11h3.5M8 15H5M16 15h3M9.5 5 8 3.5M14.5 5 16 3.5"/>'),
  check: S('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  cross: S('<path d="M6 6l12 12M18 6 6 18"/>'),
  arrow: S('<path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5"/>'),
  swap: S('<path d="M4 8h14l-3-3M20 16H6l3 3"/>'),
  bulb: S('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z" fill="currentColor" stroke="none"/>'),
  dot: S('<circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>'),
  death: S('<path d="M7 21V10a5 5 0 0 1 10 0v11z" fill="currentColor" stroke="none"/><path d="M12 9.5v6M9.5 12h5" stroke="#1a1f24"/>'),
  clock: S('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>'),
  shrine: S('<path d="M8 21h8M12 21V9"/><path d="M5 8.5 12 5l7 3.5-7 2z" fill="currentColor"/><rect x="9.5" y="12" width="5" height="6" rx="1" fill="currentColor" stroke="none"/>'),
  seed: S('<ellipse cx="12" cy="13" rx="5" ry="7" fill="currentColor" stroke="none"/><path d="M12 6c0-1.5.8-2.5 2-3"/>'),
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: string): string {
  return (ICONS as Record<string, string>)[name] ?? ICONS.dot;
}

/** Colour associated with each goal icon, used for bubbles and bars. */
export const ICON_COLORS: Record<string, string> = {
  food: '#ff7b6b',
  water: '#5cc8ff',
  sleep: '#a99cff',
  warning: '#ffcf4a',
  rain: '#8fc4e8',
  home: '#f2c46b',
  heart: '#ff7aa8',
  social: '#7fe0a8',
  build: '#f5c451',
  wood: '#d49a5c',
  hammer: '#f0b35a',
  fire: '#ff9a45',
  explore: '#8ee6d0',
  idle: '#b7d97a',
  star: '#ffe066',
  heal: '#7ef0b0',
  shrine: '#ffd66b',
};
