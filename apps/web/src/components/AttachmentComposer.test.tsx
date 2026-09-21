import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_RUN } from "@tracegraph/contracts";
import { LanguageProvider } from "../i18n";
import type { PendingAttachment } from "../model";
import { AttachmentComposer, pendingAttachmentsFromFiles } from "./AttachmentComposer";

const file = (name: string, type: string, size = 4): File => new File(
  [new Uint8Array(size)],
  name,
  { type },
);

describe("AttachmentComposer", () => {
  it("accepts only bounded PNG, JPEG, and PDF drafts and defaults them to offload", () => {
    const accepted = pendingAttachmentsFromFiles([
      file("screen.png", "image/png"),
      file("photo.jpg", "image/jpeg"),
      file("notes.pdf", "application/pdf"),
    ], []);

    expect(accepted.error).toBeNull();
    expect(accepted.attachments).toMatchObject([
      { label: "screen.png", declaredMediaType: "image/png", delivery: "offload" },
      { label: "photo.jpg", declaredMediaType: "image/jpeg", delivery: "offload" },
      { label: "notes.pdf", declaredMediaType: "application/pdf", delivery: "offload" },
    ]);
    expect(pendingAttachmentsFromFiles([file("script.html", "text/html")], []).error)
      .toBe("Only PNG, JPEG, and PDF attachments are supported.");
    expect(pendingAttachmentsFromFiles([file("huge.png", "image/png", MAX_ATTACHMENT_BYTES + 1)], []).error)
      .toBe("Each attachment must be 30 MiB or smaller.");
  });

  it("caps each Run at eight drafts and renders image inline as an explicit opt-in", () => {
    const existing: PendingAttachment[] = Array.from({ length: MAX_ATTACHMENTS_PER_RUN }, (_, index) => ({
      id: `draft:${index}`,
      label: `image-${index}.png`,
      file: file(`image-${index}.png`, "image/png"),
      declaredMediaType: "image/png",
      delivery: index === 0 ? "inline" : "offload",
    }));
    const result = pendingAttachmentsFromFiles([file("extra.png", "image/png")], existing);
    expect(result.attachments).toHaveLength(MAX_ATTACHMENTS_PER_RUN);
    expect(result.error).toBe("A Run can include at most 8 attachments.");

    const html = renderToStaticMarkup(<LanguageProvider><AttachmentComposer
      attachments={existing.slice(0, 1)}
      onChange={vi.fn()}
    /></LanguageProvider>);
    expect(html).toContain("sent with the next new task");
    expect(html).toContain("Send image to model");
    expect(html).toContain('type="checkbox" checked=""');
    expect(html).toContain("image-0.png");
  });
});
