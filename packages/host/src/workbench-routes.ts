import type {FastifyInstance} from "fastify";
import {RestoreWorkbenchSettingsRequestSchema,ModelConnectionTestRequestSchema,UpdateWorkbenchSettingsRequestSchema,WorkbenchCommandRequestSchema} from "@tracegraph/contracts";
import type {WorkbenchControl} from "./workbench-control.js";
/** Registered within the existing loopback/private-channel auth and replay hooks. */
export function registerWorkbenchRoutes(app:FastifyInstance,control:WorkbenchControl):void {
  app.get("/api/workbench/settings",()=>control.settings());
  app.post("/api/workbench/settings",request=>control.updateSettings(UpdateWorkbenchSettingsRequestSchema.parse(request.body)));
  app.get("/api/workbench/settings/history",()=>control.settingsHistory());
  app.post("/api/workbench/settings/restore",request=>control.restoreSettings(RestoreWorkbenchSettingsRequestSchema.parse(request.body)));
  app.get("/api/workbench/capabilities",()=>control.capabilities());
  app.get("/api/workbench/resources",()=>control.resources());
  app.post("/api/workbench/model-test",request=>control.testModel(ModelConnectionTestRequestSchema.parse(request.body).command_id));
  app.post("/api/workbench/commands",request=>control.command(WorkbenchCommandRequestSchema.parse(request.body)));
}
