export interface Page {
  el: HTMLElement;
  destroy?(): void;
}

export type PageFactory = () => Page;

/** Hash router (#/settings): no server routes needed, works offline from the service-worker cache. */
export class Router {
  private readonly outlet: HTMLElement;
  private readonly routes: Record<string, PageFactory>;
  private readonly onChange: (path: string) => void;
  private current: Page | null = null;
  private currentPath = '';

  constructor(outlet: HTMLElement, routes: Record<string, PageFactory>, onChange?: (path: string) => void) {
    this.outlet = outlet;
    this.routes = routes;
    this.onChange = onChange ?? (() => {});
  }

  static pathOf(hash: string): string {
    return hash.replace(/^#/, '') || '/';
  }

  start(): void {
    window.addEventListener('hashchange', this.render);
    this.render();
  }

  stop(): void {
    window.removeEventListener('hashchange', this.render);
    this.current?.destroy?.();
    this.current = null;
    this.currentPath = '';
  }

  private readonly render = (): void => {
    const wanted = Router.pathOf(location.hash);
    const path = this.routes[wanted] ? wanted : '/';
    if (path === this.currentPath) return;
    this.current?.destroy?.();
    const page = this.routes[path]();
    page.el.classList.add('fade-in');
    this.outlet.replaceChildren(page.el);
    this.current = page;
    this.currentPath = path;
    window.scrollTo?.(0, 0);
    this.onChange(path);
  };
}
