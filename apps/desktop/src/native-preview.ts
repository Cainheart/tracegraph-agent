import { BrowserWindow, WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import { IdentifierSchema, type PreviewSnapshot } from "@tracegraph/contracts";
import type { TraceGraphClient } from "@tracegraph/sdk";

export function resolvePreviewUrl(preview: PreviewSnapshot): URL {
  const url = new URL(preview.url);
  if (preview.state !== "ready" || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || !url.port || Number(url.port) < 1024) {
    throw new Error("Only a ready Host-managed loopback preview can be opened");
  }
  return url;
}

/** Untrusted project content has an independent sandbox and never receives the app preload. */
export class NativePreviewManager {
  #window: BrowserWindow | undefined;
  #view: WebContentsView | undefined;
  async open(parent: BrowserWindow, client: TraceGraphClient, input: unknown): Promise<void> {
    const id = IdentifierSchema.parse(input);
    const preview = (await client.getWorkbenchResources()).previews.find((entry) => entry.preview_id === id);
    if (preview === undefined) throw new Error("Preview is unavailable");
    const url = resolvePreviewUrl(preview);
    this.close();
    const view = new WebContentsView({ webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, partition: `outlive-preview-${randomUUID()}`,
    } });
    const window = new BrowserWindow({ parent, title: "Outlive project preview", width: 1100, height: 760, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.#window = window; this.#view = view;
    window.contentView.addChildView(view);
    const layout = (): void => { const { width, height } = window.getContentBounds(); view.setBounds({ x: 0, y: 0, width, height }); };
    layout(); window.on("resize", layout);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event, target) => { if (!sameOrigin(target, url)) event.preventDefault(); });
    view.webContents.on("will-redirect", (event, target) => { if (!sameOrigin(target, url)) event.preventDefault(); });
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.session.on("will-download", (event) => event.preventDefault());
    view.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !sameOrigin(details.url, url) && !details.url.startsWith("data:") && !details.url.startsWith("blob:") }));
    window.once("closed", () => { if (this.#window === window) { this.#window = undefined; this.#view = undefined; } if (!view.webContents.isDestroyed()) view.webContents.close(); });
    try { await view.webContents.loadURL(url.href); window.show(); }
    catch { this.close(); throw new Error("The local project preview could not be loaded"); }
  }
  close(): void {
    const window = this.#window, view = this.#view;
    this.#window = undefined; this.#view = undefined;
    if (window && !window.isDestroyed()) window.close();
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
  }
}
function sameOrigin(target: string, allowed: URL): boolean { try { const url = new URL(target); if (url.protocol === "ws:") url.protocol = "http:"; return url.origin === allowed.origin; } catch { return false; } }
