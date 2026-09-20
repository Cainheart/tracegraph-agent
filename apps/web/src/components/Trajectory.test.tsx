import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../i18n";
import { VerifiedAttachmentPreview } from "./Trajectory";

describe("VerifiedAttachmentPreview", () => {
  it("renders verified image bytes as an image preview", () => {
    const html = renderToStaticMarkup(<LanguageProvider><VerifiedAttachmentPreview
      mediaType="image/png"
      objectUrl="blob:verified-image"
    /></LanguageProvider>);

    expect(html).toContain("<img");
    expect(html).toContain("blob:verified-image");
    expect(html).not.toContain("<iframe");
  });

  it("offers untrusted PDFs only as downloads and never embeds them", () => {
    const html = renderToStaticMarkup(<LanguageProvider><VerifiedAttachmentPreview
      mediaType="application/pdf"
      objectUrl="blob:verified-pdf"
    /></LanguageProvider>);

    expect(html).toContain('download="tracegraph-attachment.pdf"');
    expect(html).toContain("PDF is not embedded because uploaded documents are untrusted.");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<embed");
    expect(html).not.toContain("<object");
  });
});
