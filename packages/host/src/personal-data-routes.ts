import type {FastifyInstance} from "fastify";
import {IdentifierSchema,PersonalProfileUpdateRequestSchema,PersonalUsageQuerySchema,PublicSessionSearchQuerySchema} from "@tracegraph/contracts";
import type {PersonalDataController} from "./personal-data-control.js";
export function registerPersonalDataRoutes(app:FastifyInstance,control:PersonalDataController){
 app.get("/api/workbench/personal/profile",()=>control.profile());
 app.post("/api/workbench/personal/profile",request=>control.updateProfile(PersonalProfileUpdateRequestSchema.parse(request.body)));
 app.get<{Params:{commandId:string}}>("/api/workbench/personal/profile/commands/:commandId",request=>control.reconcileProfile(IdentifierSchema.parse(request.params.commandId)));
 app.get("/api/workbench/personal/usage",request=>control.usage(PersonalUsageQuerySchema.parse(request.query)));
 app.get("/api/workbench/personal/search",request=>control.search(PublicSessionSearchQuerySchema.parse({...request.query as object,...((request.query as {limit?:unknown}).limit===undefined?{}:{limit:Number((request.query as {limit:string}).limit)})})));
}
