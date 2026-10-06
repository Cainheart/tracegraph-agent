import { useEffect, useRef, useState } from "react";
import { PersonalProfileUpdateRequestSchema, type HostCapabilities, type PersonalProfileSnapshot, type PersonalProfileValues } from "@tracegraph/contracts";
import type { WorkbenchClient } from "../client";
import { mutationWasRejected } from "../mutation-rejection";
import { useI18n } from "../i18n";
import { capabilityAvailable, capabilityReadable, commandId, safeError } from "./UnifiedSettings";

export function PersonalProfile({ client, capabilities, online, generation }: { client: WorkbenchClient; capabilities: HostCapabilities | null; online: boolean; generation?: number | undefined }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<PersonalProfileSnapshot | null>(null), [draft, setDraft] = useState<PersonalProfileValues>({ display_name: "", bio: "", avatar_color: "slate" });
  const [observed, setObserved] = useState<PersonalProfileSnapshot | null>(null), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<{ command_id: string; profile_id: string; values: PersonalProfileValues } | null>(null);
  const dirty = useRef(false), revision = useRef(0);
  const readable = online && capabilityReadable(capabilities, "personal.read") && Boolean(client.getPersonalProfile);
  const writable = online && !busy && pending === null && capabilityAvailable(capabilities, "personal.write") && Boolean(client.updatePersonalProfile);
  const receive = (value: PersonalProfileSnapshot) => { setSnapshot(value); if (!dirty.current) setDraft(value.values); };
  const refresh = async () => { if (!readable) return; const version = ++revision.current; setLoading(true); setError(null); try { const next = await client.getPersonalProfile!(); if (version === revision.current) receive(next); } catch (caught) { if (version === revision.current) setError(safeError(caught)); } finally { if (version === revision.current) setLoading(false); } };
  useEffect(() => { if (readable) void refresh(); else setLoading(false); return () => { revision.current++; }; }, [client, readable, generation]);
  const update = (patch: Partial<PersonalProfileValues>) => { dirty.current = true; setDraft((prior) => ({ ...prior, ...patch })); setMessage(null); };
  const save = async () => {
    if (!snapshot || !writable) return;
    let input; try { input = PersonalProfileUpdateRequestSchema.parse({ command_id: commandId(), expected_revision: snapshot.revision, values: draft }); } catch { setError(t("Enter a display name of at most 80 characters and a bio of at most 1,000 characters.")); return; }
    setBusy(true); setError(null); setMessage(null);
    try {
      const receipt = await client.updatePersonalProfile!(input);
      if (receipt.profile_id !== snapshot.profile_id || receipt.last_command_id !== input.command_id) throw new Error("Personal profile receipt does not match the original update.");
      dirty.current = false; setSnapshot(receipt); setDraft(receipt.values); setObserved(null); setMessage(t("Your local profile was saved. It is not sent to a model."));
    } catch (caught) { setError(safeError(caught)); if (!mutationWasRejected(caught)) setPending({ command_id: input.command_id, profile_id: snapshot.profile_id, values: input.values }); else setMessage(t("The profile update was refused. Refresh its current version before saving again.")); }
    finally { setBusy(false); }
  };
  const inspect = async () => {
    if (!pending || !online || busy || !capabilityReadable(capabilities, "personal.reconcile") || !client.getPersonalProfileCommandReceipt) return;
    setBusy(true); setError(null);
    try {
      const receipt = await client.getPersonalProfileCommandReceipt(pending.command_id);
      if (receipt.command_id !== pending.command_id || receipt.result && (receipt.result.profile_id !== pending.profile_id || receipt.result.last_command_id !== pending.command_id)) throw new Error("Personal profile receipt does not match the original update.");
      if (receipt.state === "completed" && receipt.result) { dirty.current = false; setSnapshot(receipt.result); setDraft(receipt.result.values); setPending(null); setObserved(null); setMessage(t("The original profile update has a verified receipt. It was not repeated.")); }
      else if (receipt.state === "failed" && mutationWasRejected({ status: 409, body: { error: receipt.code } })) { setPending(null); setMessage(t("The profile update was refused. Refresh its current version before saving again.")); }
      else { setObserved(receipt.observed_profile ?? null); setMessage(`${t("Profile update remains unresolved")}: ${t(receipt.state)}${receipt.code ? ` · ${receipt.code}` : ""}`); }
    } catch (caught) { setError(safeError(caught)); }
    finally { setBusy(false); }
  };
  const colors: PersonalProfileValues["avatar_color"][] = ["slate", "blue", "green", "amber", "rose", "violet"];
  return <section className="personal-profile"><header><div className={`personal-avatar avatar-${draft.avatar_color}`} aria-hidden="true">{draft.display_name.trim().slice(0, 1) || "O"}</div><div><h3>{t("Your private local profile")}</h3><p>{t("Your name and bio stay on this device. They are not added to model prompts.")}</p></div></header>{!online && <p role="status">{t("Reconnect to read or save your profile. Your draft is preserved.")}</p>}{online && !readable && <p>{t("Personal profile is unavailable in this installation. Your conversations remain available.")}</p>}{loading && <p role="status">{t("Loading profile…")}</p>}{error && <p role="alert">{t(error)}</p>}{message && <p role="status">{message}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}><label>{t("Display name")}<input aria-label={t("Profile display name")} maxLength={80} value={draft.display_name} disabled={busy || pending !== null} onChange={(event) => update({ display_name: event.target.value })} /></label><label>{t("Bio")}<textarea aria-label={t("Profile bio")} maxLength={1000} rows={3} value={draft.bio} disabled={busy || pending !== null} onChange={(event) => update({ bio: event.target.value })} /></label><label>{t("Avatar color")}<select aria-label={t("Profile avatar color")} value={draft.avatar_color} disabled={busy || pending !== null} onChange={(event) => update({ avatar_color: event.target.value as PersonalProfileValues["avatar_color"] })}>{colors.map((color) => <option key={color} value={color}>{t(color)}</option>)}</select></label><div className="settings-button-row"><button className="button primary" disabled={!snapshot || !writable || !dirty.current} type="submit">{t("Save profile")}</button><button className="button subtle" disabled={!readable || busy} onClick={() => void refresh()} type="button">{t("Refresh profile")}</button></div></form>
    {pending && <div role="alert"><p>{t("The profile update has an unknown outcome. Your draft is retained; inspect the original receipt before saving again.")}</p><code>{pending.command_id}</code><button className="button subtle" disabled={!online || busy || !capabilityReadable(capabilities, "personal.reconcile") || !client.getPersonalProfileCommandReceipt} onClick={() => void inspect()} type="button">{t("Inspect original profile update")}</button></div>}{observed && <details className="profile-observed-state"><summary>{t("Observed profile is not a completed receipt")}</summary><p>{observed.values.display_name} · {t("Revision")} {observed.revision}</p><p>{t("These saved values were observed, but the original update is still unresolved. Your intended draft has not been replaced.")}</p></details>}{snapshot && <small className="setting-metadata">{t("Scope")}: {t("Local profile")} · {t("Revision")} {snapshot.revision} · {t("Model transmission")}: {t("Off")}</small>}
  </section>;
}
