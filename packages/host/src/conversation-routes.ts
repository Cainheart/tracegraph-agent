import type {FastifyInstance} from "fastify";
import {ProjectRunDefaultsUpdateRequestSchema,SessionRunOptionsResetRequestSchema,IdentifierSchema,ModelConnectionSaveRequestSchema,ModelConnectionRemoveRequestSchema,ModelConnectionTestRequestSchema,ModelCatalogDiscoveryRequestSchema,SessionRunOptionsUpdateRequestSchema,PermissionGrantUpdateRequestSchema} from "@tracegraph/contracts";
import type {ConversationControl} from "./conversation-control.js";
/** Registered under the existing authentication, replay denial and command-id middleware. */
export function registerConversationRoutes(app:FastifyInstance,control:ConversationControl){
 app.get("/api/workbench/models",()=>control.snapshot());
 app.post("/api/workbench/models",request=>control.save(ModelConnectionSaveRequestSchema.parse(request.body)));
 app.post<{Params:{id:string}}>("/api/workbench/models/:id/remove",request=>control.remove(IdentifierSchema.parse(request.params.id),ModelConnectionRemoveRequestSchema.parse(request.body)));
 app.post<{Params:{id:string}}>("/api/workbench/models/:id/test",request=>control.test(IdentifierSchema.parse(request.params.id),ModelConnectionTestRequestSchema.parse(request.body).command_id));
 app.post<{Params:{id:string}}>("/api/workbench/models/:id/discover",request=>control.discoverModels(IdentifierSchema.parse(request.params.id),ModelCatalogDiscoveryRequestSchema.parse(request.body)));
 app.get<{Params:{id:string}}>("/api/workbench/sessions/:id/options",request=>control.options(IdentifierSchema.parse(request.params.id)));
 app.post<{Params:{id:string}}>("/api/workbench/sessions/:id/options",request=>control.updateOptions(IdentifierSchema.parse(request.params.id),SessionRunOptionsUpdateRequestSchema.parse(request.body)));
 app.post<{Params:{id:string}}>("/api/workbench/sessions/:id/options/reset",request=>control.resetOptions(IdentifierSchema.parse(request.params.id),SessionRunOptionsResetRequestSchema.parse(request.body)));
 app.get<{Params:{id:string}}>("/api/workbench/projects/:id/defaults",request=>control.projectDefaults(IdentifierSchema.parse(request.params.id)));
 app.post<{Params:{id:string}}>("/api/workbench/projects/:id/defaults",request=>control.updateProjectDefaults(IdentifierSchema.parse(request.params.id),ProjectRunDefaultsUpdateRequestSchema.parse(request.body)));
 app.get("/api/workbench/permission-grant",()=>control.getPermissionGrant());
 app.post("/api/workbench/permission-grant",request=>control.setPermissionGrant(PermissionGrantUpdateRequestSchema.parse(request.body)));
}
