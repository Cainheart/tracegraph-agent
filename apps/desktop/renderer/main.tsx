import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, DemoTraceGraphClient, LiveTraceGraphClient } from "@tracegraph/workbench";
import "@tracegraph/workbench/styles.css";
import "@tracegraph/workbench/workbench.css";
import { createDesktopSdkPort } from "../src/desktop-sdk.js";
import "../src/renderer-bridge.js";

const root = document.getElementById("root");
if (!root) throw new Error("Outlive Agent Desktop renderer root was not found");

const preview = new URLSearchParams(window.location.search).get("preview") === "1";
const client = preview
  ? new DemoTraceGraphClient()
  : new LiveTraceGraphClient({ sdk: createDesktopSdkPort(window.tracegraphDesktop) });

createRoot(root).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
