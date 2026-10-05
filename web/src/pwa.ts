export function registerServiceWorker(nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): Promise<boolean> {
  if (!nav || !('serviceWorker' in nav) || !nav.serviceWorker) return Promise.resolve(false);
  return nav.serviceWorker.register('/sw.js').then(
    () => true,
    () => false,
  );
}
