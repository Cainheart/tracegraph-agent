import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, LiveTraceGraphClient } from "@tracegraph/workbench";
import "@tracegraph/workbench/styles.css";
import "@tracegraph/workbench/workbench.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Outlive Agent Web root element was not found");
}

const client = new LiveTraceGraphClient({ baseUrl: import.meta.env.VITE_TRACEGRAPH_API_URL ?? "" });

createRoot(root).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
