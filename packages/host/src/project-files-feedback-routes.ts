import type {FastifyInstance} from "fastify";
import {IdentifierSchema,ProjectFileListRequestSchema,ProjectFileReadRequestSchema,ProjectFileSaveRequestSchema,ProjectFileReconcileRequestSchema,AnswerFeedbackRequestSchema} from "@tracegraph/contracts";
import type {ProjectFilesFeedbackController} from "./project-files-feedback.js";
/** Existing Host auth/replay/mutation lifecycle hooks govern every route. */
export function registerProjectFilesFeedbackRoutes(app:FastifyInstance,control:ProjectFilesFeedbackController):void {
 const project=(request:{params:unknown})=>IdentifierSchema.parse((request.params as {projectId:string}).projectId);
 app.post("/api/workbench/projects/:projectId/files/list",request=>control.list(project(request),ProjectFileListRequestSchema.parse(request.body??{})));
 app.post("/api/workbench/projects/:projectId/files/read",request=>control.read(project(request),ProjectFileReadRequestSchema.parse(request.body)));
 app.post("/api/workbench/projects/:projectId/files/save",{bodyLimit:6*1024*1024},request=>control.save(project(request),ProjectFileSaveRequestSchema.parse(request.body)));
 app.post("/api/workbench/projects/:projectId/files/reconcile",request=>control.reconcile(project(request),ProjectFileReconcileRequestSchema.parse(request.body)));
 app.get("/api/workbench/runs/:runId/feedback",request=>control.feedback(IdentifierSchema.parse((request.params as {runId:string}).runId)));
 app.post("/api/workbench/runs/:runId/feedback",request=>control.setFeedback(IdentifierSchema.parse((request.params as {runId:string}).runId),AnswerFeedbackRequestSchema.parse(request.body)));
}
