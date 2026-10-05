export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const running = new WeakMap<Element, number>();

/** Animates a number in el from `from` to `to`; format() renders each frame. */
export function tweenNumber(el: Element, from: number, to: number, format: (v: number) => string, ms = 450): void {
  const prev = running.get(el);
  if (prev !== undefined) cancelAnimationFrame(prev);
  if (from === to || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
    running.delete(el);
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    el.textContent = format(from + (to - from) * easeOutCubic(t));
    if (t < 1) running.set(el, requestAnimationFrame(step));
    else running.delete(el);
  };
  running.set(el, requestAnimationFrame(step));
}
