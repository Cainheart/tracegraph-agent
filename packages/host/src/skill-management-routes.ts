import type { FastifyInstance } from "fastify";
import { IdentifierSchema, ManagedSkillScopeSchema, ManagedSkillSelectorSchema, ValidateManagedSkillRequestSchema, ManagedSkillCommandSchema } from "@tracegraph/contracts";
import type { SkillManagementController } from "./skill-management.js";
/** Existing authenticated live Host hooks and replay denial govern these routes. */
export function registerSkillManagementRoutes(app:FastifyInstance,control:SkillManagementController) {
  app.post("/api/workbench/skills/list",request=>control.list(ManagedSkillScopeSchema.parse(request.body)));
  app.post("/api/workbench/skills/read",request=>control.read(ManagedSkillSelectorSchema.parse(request.body)));
  app.post("/api/workbench/skills/validate",{bodyLimit:2*1024*1024},request=>control.validate(ValidateManagedSkillRequestSchema.parse(request.body)));
  app.post("/api/workbench/skills/commands",{bodyLimit:2*1024*1024},request=>control.command(ManagedSkillCommandSchema.parse(request.body)));
  app.get("/api/workbench/skills/commands/:commandId",request=>control.receipt(IdentifierSchema.parse((request.params as {commandId:string}).commandId)));
}
