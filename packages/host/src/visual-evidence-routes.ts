import type {FastifyInstance} from "fastify";
import {IdentifierSchema,VisualRetentionUpdateSchema,VisualEvidenceQuerySchema,VisualEvidencePinSchema,VisualEvidenceCleanupRequestSchema} from "@tracegraph/contracts";
import type {VisualEvidenceController} from "./visual-evidence-control.js";
/** Existing authenticated live gateway middleware rejects replay authority. */
export function registerVisualEvidenceRoutes(app:FastifyInstance,control:VisualEvidenceController){
 app.get("/api/workbench/visual-evidence/settings",()=>control.settings());
 app.post("/api/workbench/visual-evidence/settings",request=>control.updateSettings(VisualRetentionUpdateSchema.parse(request.body)));
 app.get("/api/workbench/visual-evidence",request=>{const query=request.query as Record<string,unknown>;return control.list(VisualEvidenceQuerySchema.parse({...query,...(query.limit===undefined?{}:{limit:Number(query.limit)}),...(query.offset===undefined?{}:{offset:Number(query.offset)})}));});
 app.post<{Params:{evidenceId:string}}>("/api/workbench/visual-evidence/:evidenceId/pin",request=>control.pin(IdentifierSchema.parse(request.params.evidenceId),VisualEvidencePinSchema.parse(request.body)));
 app.post("/api/workbench/visual-evidence/cleanup",request=>control.cleanup(VisualEvidenceCleanupRequestSchema.parse(request.body)));
 app.get<{Params:{commandId:string}}>("/api/workbench/visual-evidence/commands/:commandId",request=>control.reconcile(IdentifierSchema.parse(request.params.commandId)));
}
