import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n";
import { SteeringComposer } from "./SteeringComposer";

const pending = [{
  input_id: "input-message",
  run_id: "run-one",
  kind: "message" as const,
  body: "Inspect the retry path next",
  actor: "user" as const,
  submitted_at: "2026-09-19T00:00:00.000Z",
}];

function queuedMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    input_id: `input-${index}`,
    run_id: "run-one",
    kind: "message" as const,
    body: `Message ${index}`,
    actor: "user" as const,
    submitted_at: "2026-09-19T00:00:00.000Z",
  }));
}

describe("SteeringComposer", () => {
  it("keeps the runtime composer visible with durable queue and consumption facts", () => {
    const html = renderToStaticMarkup(<LanguageProvider><SteeringComposer
      busy={false}
      cancelBusy={false}
      disabledReason={null}
      error={null}
      kind="message"
      lastConsumed={{
        input_id: "input-earlier",
        kind: "approve_hint",
        consumed_at: "2026-09-19T00:00:01.000Z",
        at_step: 3,
        queued_event_id: "event-queued-earlier",
      }}
      onCancel={vi.fn()}
      onKindChange={vi.fn()}
      onSubmit={vi.fn()}
      onValueChange={vi.fn()}
      pending={pending}
      value="Check cancellation safety"
    /></LanguageProvider>);

    expect(html).toContain("Queue mode");
    expect(html).toContain("will be sent at the next safe step");
    expect(html).toContain("Inspect the retry path next");
    expect(html).toContain("Last consumed at step");
    expect(html).toContain("<code>3</code>");
    expect(html).toContain('value="approve_hint"');
    expect(html).toContain("Cancel run safely");
    expect(html).toContain("Attachments are available only for the next new task");
    expect(html).not.toContain('type="file"');
  });

  it("keeps recovered pending input visible but disables new writes for interrupted Runs", () => {
    const html = renderToStaticMarkup(<LanguageProvider><SteeringComposer
      busy={false}
      cancelBusy={false}
      disabledReason="Steering is unavailable while the Run is interrupted. Resume the Run first."
      error={null}
      kind="message"
      onCancel={vi.fn()}
      onKindChange={vi.fn()}
      onSubmit={vi.fn()}
      onValueChange={vi.fn()}
      pending={pending}
      value=""
    /></LanguageProvider>);

    expect(html).toContain("Inspect the retry path next");
    expect(html).toContain('textarea aria-label="Steer this run" disabled=""');
    expect(html).toContain("Run is interrupted");
  });

  it("does not offer a dequeue action and deduplicates an already queued cancellation", () => {
    const html = renderToStaticMarkup(<LanguageProvider><SteeringComposer
      busy={false}
      cancelBusy={false}
      disabledReason={null}
      error={null}
      kind="message"
      onCancel={vi.fn()}
      onKindChange={vi.fn()}
      onSubmit={vi.fn()}
      onValueChange={vi.fn()}
      pending={[...pending, {
        input_id: "input-cancel",
        run_id: "run-one",
        kind: "cancel",
        body: "",
        actor: "user",
        submitted_at: "2026-09-19T00:00:02.000Z",
      }]}
      value=""
    /></LanguageProvider>);

    expect(html).toContain("Cancellation queued");
    expect(html).toContain('textarea aria-label="Steer this run" disabled=""');
    expect(html).not.toContain("Remove queued input");
  });

  it("reserves slot 100 for emergency cancellation", () => {
    const html = renderToStaticMarkup(<LanguageProvider><SteeringComposer
      busy={false}
      cancelBusy={false}
      disabledReason={null}
      error={null}
      kind="approve_hint"
      onCancel={vi.fn()}
      onKindChange={vi.fn()}
      onSubmit={vi.fn()}
      onValueChange={vi.fn()}
      pending={queuedMessages(99)}
      value="Queue one more hint"
    /></LanguageProvider>);
    const cancelButton = html.match(/<button[^>]*class="button subtle steering-cancel"[^>]*>/u)?.[0];
    const queueButton = html.match(/<button[^>]*aria-label="Queue input"[^>]*>/u)?.[0];

    expect(html).toContain("The final queue slot is reserved for emergency cancellation.");
    expect(html).toContain('textarea aria-label="Steer this run" disabled=""');
    expect(queueButton).toContain('disabled=""');
    expect(cancelButton).not.toContain('disabled=""');
  });

  it("disables emergency cancellation only when all 100 slots are occupied", () => {
    const html = renderToStaticMarkup(<LanguageProvider><SteeringComposer
      busy={false}
      cancelBusy={false}
      disabledReason={null}
      error={null}
      kind="message"
      onCancel={vi.fn()}
      onKindChange={vi.fn()}
      onSubmit={vi.fn()}
      onValueChange={vi.fn()}
      pending={queuedMessages(100)}
      value=""
    /></LanguageProvider>);
    const cancelButton = html.match(/<button[^>]*class="button subtle steering-cancel"[^>]*>/u)?.[0];

    expect(html).toContain("The input queue is full. Wait for the next safe step.");
    expect(cancelButton).toContain('disabled=""');
  });

  it("keeps emergency cancellation available while another Run command is busy", () => {
    const html = renderToStaticMarkup(<LanguageProvider><SteeringComposer
      busy
      cancelBusy={false}
      disabledReason={null}
      error={null}
      kind="message"
      onCancel={vi.fn()}
      onKindChange={vi.fn()}
      onSubmit={vi.fn()}
      onValueChange={vi.fn()}
      pending={pending}
      value="Wait for the current command"
    /></LanguageProvider>);
    const cancelButton = html.match(/<button[^>]*class="button subtle steering-cancel"[^>]*>/u)?.[0];
    const queueButton = html.match(/<button[^>]*aria-label="Queue input"[^>]*>/u)?.[0];

    expect(queueButton).toContain('disabled=""');
    expect(cancelButton).not.toContain('disabled=""');
  });
});
