import { useState } from "react";
import { McpConfigSchema, type McpConfig } from "@tracegraph/contracts";
import { useI18n } from "../i18n";

export function McpConnectionForm({ value, disabled, onSave }: { value: McpConfig; disabled: boolean; onSave: (value: McpConfig) => Promise<unknown> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), [transport, setTransport] = useState<"stdio" | "streamable-http">("streamable-http");
  const [name, setName] = useState(""), [address, setAddress] = useState(""), [args, setArgs] = useState(""), [reference, setReference] = useState(""), [allowed, setAllowed] = useState("");
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const save = async () => {
    if (disabled || saving) return;
    setError(null);
    try {
      const tool_policy = { allow: allowed.split(",").map((tool) => tool.trim()).filter(Boolean) };
      const server = transport === "streamable-http" ? { name, transport, url: address, ...(reference.trim() ? { authorization_ref: reference.trim() } : {}), required: false, tool_policy } : { name, transport, command: address, args: args.split("\n").map((arg) => arg.trim()).filter(Boolean), env: {}, required: false, tool_policy };
      const next = McpConfigSchema.parse({ ...value, servers: [...value.servers, server] });
      setSaving(true); await onSave(next); setOpen(false); setName(""); setAddress(""); setArgs(""); setReference(""); setAllowed("");
    } catch (caught) { setError(caught instanceof Error && !('issues' in caught) ? caught.message : t("Check the server name, HTTPS address, credential reference and permitted tool names.")); }
    finally { setSaving(false); }
  };
  return <div className="mcp-connection-form"><button className="button subtle" disabled={disabled || saving} onClick={() => setOpen(!open)} aria-expanded={open} type="button">{t(open ? "Cancel" : "Add MCP server")}</button>{open && <form onSubmit={(event) => { event.preventDefault(); void save(); }}><p>{t("Optional connections do not block chat. New servers start with only the tool names you explicitly allow.")}</p><label>{t("Connection type")}<select aria-label={t("MCP connection type")} value={transport} onChange={(event) => setTransport(event.target.value as typeof transport)}><option value="streamable-http">{t("Remote HTTPS")}</option><option value="stdio">{t("Local process")}</option></select></label><label>{t("Server name")}<input aria-label={t("MCP server name")} required value={name} onChange={(event) => setName(event.target.value)} /></label><label>{t(transport === "streamable-http" ? "HTTPS endpoint" : "Executable")}<input aria-label={t("MCP address")} required value={address} placeholder={transport === "streamable-http" ? "https://example.com/mcp" : "node"} onChange={(event) => setAddress(event.target.value)} /></label>{transport === "stdio" ? <label>{t("Arguments, one per line")}<textarea aria-label={t("MCP arguments")} value={args} onChange={(event) => setArgs(event.target.value)} /></label> : <label>{t("Credential reference")}<input aria-label={t("MCP credential reference")} value={reference} placeholder="${secret:MY_MCP_TOKEN}" onChange={(event) => setReference(event.target.value)} /></label>}<label>{t("Allowed tool names, comma separated")}<input aria-label={t("Allowed MCP tools")} value={allowed} onChange={(event) => setAllowed(event.target.value)} /></label><small>{t("An empty list permits no tools. Add names after checking the server documentation or discovered tool catalog.")}</small><button className="button primary" disabled={disabled || saving} type="submit">{t(saving ? "Saving…" : "Validate and save")}</button>{error && <p role="alert">{error}</p>}</form>}</div>;
}
