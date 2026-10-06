import type { FastifyInstance } from "fastify";
import { GoalCreateRequestSchema, GoalCommandRequestSchema, IdentifierSchema } from "@tracegraph/contracts";
import type { GoalController } from "./goal-controller.js";

export function registerGoalRoutes(app: FastifyInstance, control: GoalController): void {
  app.get("/api/workbench/goals", () => control.list());
  app.post("/api/workbench/goals", request => control.create(GoalCreateRequestSchema.parse(request.body)));
  app.get<{Params:{commandId:string}}>("/api/workbench/goals/creation-commands/:commandId",request=>control.reconcileCreation(IdentifierSchema.parse(request.params.commandId)));
  app.get<{ Params: { id: string } }>("/api/workbench/goals/:id", request => control.read(IdentifierSchema.parse(request.params.id)));
  app.get<{ Params: { id: string } }>("/api/workbench/goals/:id/budget", request => control.budget(IdentifierSchema.parse(request.params.id)));
  app.post<{ Params: { id: string } }>("/api/workbench/goals/:id/commands", request => control.command(IdentifierSchema.parse(request.params.id), GoalCommandRequestSchema.parse(request.body)));
  app.get<{Params:{id:string;commandId:string}}>("/api/workbench/goals/:id/commands/:commandId",request=>control.reconcile(IdentifierSchema.parse(request.params.id),IdentifierSchema.parse(request.params.commandId)));
}
