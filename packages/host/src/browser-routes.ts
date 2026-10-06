import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { BrowserCommandSchema, BrowserGrantRequestSchema, IdentifierSchema } from "@tracegraph/contracts";
import type { BrowserControl } from "./browser-control.js";

/** Existing live authentication/replay hooks govern this feature as other Host routes. */
export function registerBrowserRoutes(app: FastifyInstance, control: BrowserControl): void {
  app.get("/api/workbench/browser", () => control.status());
  app.post("/api/workbench/browser/grants", request => control.requestGrant(BrowserGrantRequestSchema.parse(request.body)));
  app.post("/api/workbench/browser/commands", request => control.command(BrowserCommandSchema.parse(request.body)));
  app.get<{Params:{id:string}}>("/api/workbench/browser/commands/:id",request=>control.reconcile(IdentifierSchema.parse(request.params.id)));
  app.post<{ Params: { id: string } }>("/api/workbench/browser/tabs/:id/observe", request => control.observe(IdentifierSchema.parse(request.params.id)));
  app.get<{ Params: { id: string } }>("/api/workbench/browser/evidence/:id", async (request, reply) => {
    const bytes = await control.evidence(IdentifierSchema.parse(request.params.id));
    return reply.type("image/png").header("cache-control", "no-store").header("x-outlive-content-sha256", "sha256:" + createHash("sha256").update(bytes).digest("hex")).send(Buffer.from(bytes));
  });
}
