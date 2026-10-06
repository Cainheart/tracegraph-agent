export interface WindowBounds { x: number; y: number; width: number; height: number; }
export interface PresentationWindow {
  getBounds(): WindowBounds;
  setBounds(bounds: WindowBounds): void;
  setMinimumSize(width: number, height: number): void;
  setAlwaysOnTop(enabled: boolean): void;
  isDestroyed(): boolean;
}
export interface WindowPresentationState { floating: boolean; alwaysOnTop: boolean; }

/** Presentation only: never loads a renderer, obtains a client, or submits work. */
export class WindowPresentation {
  #window: PresentationWindow | undefined;
  #normal: WindowBounds | undefined;
  #floating = false;
  #alwaysOnTop = false;
  constructor(readonly workArea: (bounds: WindowBounds) => WindowBounds) {}
  state(): WindowPresentationState { return { floating: this.#floating, alwaysOnTop: this.#alwaysOnTop }; }
  attach(window: PresentationWindow): void {
    this.#window = window; this.#normal = window.getBounds();
    window.setAlwaysOnTop(this.#alwaysOnTop);
    if (this.#floating) this.#resize(true);
  }
  detach(window: PresentationWindow): void { if (this.#window === window) this.#window = undefined; }
  setFloating(enabled: boolean): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) throw new Error("The Desktop window is unavailable");
    if (enabled === this.#floating) return;
    if (enabled) this.#normal = window.getBounds();
    this.#resize(enabled); this.#floating = enabled;
  }
  setAlwaysOnTop(enabled: boolean): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) throw new Error("The Desktop window is unavailable");
    window.setAlwaysOnTop(enabled); this.#alwaysOnTop = enabled;
  }
  #resize(floating: boolean): void {
    const window = this.#window!;
    const current = window.getBounds(), area = this.workArea(current);
    const desired = floating ? { ...current, width: 880, height: 700 } : this.#normal ?? current;
    const width = Math.min(desired.width, area.width), height = Math.min(desired.height, area.height);
    window.setMinimumSize(Math.min(floating ? 760 : 980, width), Math.min(floating ? 560 : 640, height));
    window.setBounds({ width, height, x: Math.max(area.x, Math.min(desired.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(desired.y, area.y + area.height - height)) });
  }
}
