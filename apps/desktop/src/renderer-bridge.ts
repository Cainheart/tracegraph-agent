import type { DesktopBridgeApi } from "./bridge-contract.js";

declare global {
  interface Window {
    readonly tracegraphDesktop: DesktopBridgeApi;
  }
}

export {};
