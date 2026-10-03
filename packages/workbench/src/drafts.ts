import { useRef, useState } from "react";
import type { PendingAttachment } from "./model";
import type { ProjectFileContextRef } from "@tracegraph/contracts";

export interface PendingProjectFileContext extends ProjectFileContextRef { readonly byte_length: number }
export interface ConversationDraft { readonly text: string; readonly attachments: readonly PendingAttachment[]; readonly fileContexts: readonly PendingProjectFileContext[] }
const empty: ConversationDraft = { text: "", attachments: [], fileContexts: [] };

/** Ephemeral, conversation-scoped drafts. Files and credentials never enter localStorage. */
export function useConversationDraft(scope: string) {
  const drafts = useRef(new Map<string, ConversationDraft>());
  const [, update] = useState(0);
  const draft = drafts.current.get(scope) ?? empty;
  const set = (patch: Partial<ConversationDraft>) => { drafts.current.set(scope, { ...(drafts.current.get(scope) ?? empty), ...patch }); update((value) => value + 1); };
  return { draft, setText: (text: string) => set({ text }), setAttachments: (attachments: readonly PendingAttachment[]) => set({ attachments }), setFileContexts: (fileContexts: readonly PendingProjectFileContext[]) => set({ fileContexts }), clear: () => { drafts.current.delete(scope); update((value) => value + 1); } };
}
