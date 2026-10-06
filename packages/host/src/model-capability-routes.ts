import type { FastifyInstance } from "fastify";
import { IdentifierSchema, ModelCapabilityTestRequestSchema } from "@tracegraph/contracts";
import type { ModelCapabilityControl } from "./model-capability-control.js";
export function registerModelCapabilityRoutes(app: FastifyInstance, control: ModelCapabilityControl) {
  app.post<{ Params: { id: string } }>("/api/workbench/models/:id/capability-tests", request => control.test(IdentifierSchema.parse(request.params.id), ModelCapabilityTestRequestSchema.parse(request.body)));
  app.get<{ Params: { commandId: string } }>("/api/workbench/model-capability-tests/:commandId", request => control.receipt(IdentifierSchema.parse(request.params.commandId)));
}
