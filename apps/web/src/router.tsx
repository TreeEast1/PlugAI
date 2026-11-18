import { useSyncExternalStore } from 'react';

/** Deploy prefix, e.g. "/PlugAI/" on GitHub Pages, "/" locally. Always starts and ends with "/". */
export const BASE: string = (() => {
  const b = import.meta.env.BASE_URL || '/';
  return b.endsWith('/') ? b : `${b}/`;
})();

/** App route ("/cases/x") -> URL the browser should show, including the deploy prefix. */
export function toUrl(route: string): string {
  if (/^(https?:|mailto:)/.test(route) || route.startsWith('#')) return route;
  const path = route.startsWith('/') ? route : `/${route}`;
  return (BASE + path.slice(1)).replace(/\/+/g, '/');
}

/** Browser pathname -> app route, with the deploy prefix removed. */
export function fromUrl(pathname: string): string {
  const prefix = BASE.replace(/\/$/, '');
  const stripped = prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = toUrl(to);
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  listeners.forEach((l) => l());
  if (!to.includes('#')) window.scrollTo({ top: 0 });
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname + location.search,
  );
}

export function Link({ to, children, className, onClick }: { to: string; children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <a
      href={toUrl(to)}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || /^(https?:|mailto:)/.test(to)) return;
        e.preventDefault();
        onClick?.();
        if (to.startsWith('#')) document.querySelector(to)?.scrollIntoView({ behavior: 'smooth' });
        else navigate(to);
      }}
    >
      {children}
    </a>
  );
}
