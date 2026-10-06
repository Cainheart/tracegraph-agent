import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { ComputerGrantRequestSchema,ComputerRevokeGrantRequestSchema,ComputerLeaseRequestSchema,ComputerLeaseResumeRequestSchema,ComputerLeaseReleaseRequestSchema,ComputerObserveRequestSchema,ComputerActionRequestSchema,ComputerCaptureContentRequestSchema,IdentifierSchema } from "@tracegraph/contracts";
import type { ComputerControl } from "./computer-control.js";
/** Existing live authentication and replay admission apply before these handlers. */
export function registerComputerRoutes(app:FastifyInstance,control:ComputerControl):void {
 app.get('/api/workbench/computer',()=>control.status());
 app.get('/api/workbench/computer/targets',()=>control.targets());
 app.get<{Params:{id:string}}>('/api/workbench/computer/commands/:id',request=>control.reconcile(IdentifierSchema.parse(request.params.id)));
 app.post('/api/workbench/computer/grants',request=>control.requestGrant(ComputerGrantRequestSchema.parse(request.body)));
 app.post('/api/workbench/computer/revoke',request=>control.revokeGrant(ComputerRevokeGrantRequestSchema.parse(request.body)));
 app.post('/api/workbench/computer/leases',request=>control.acquireLease(ComputerLeaseRequestSchema.parse(request.body)));
 app.post('/api/workbench/computer/resume',request=>control.resumeLease(ComputerLeaseResumeRequestSchema.parse(request.body)));
 app.post('/api/workbench/computer/release',request=>control.releaseLease(ComputerLeaseReleaseRequestSchema.parse(request.body)));
 app.post('/api/workbench/computer/observe',request=>control.observe(ComputerObserveRequestSchema.parse(request.body)));
 app.post('/api/workbench/computer/actions',request=>control.act(ComputerActionRequestSchema.parse(request.body)));
 app.post('/api/workbench/computer/capture',async(request,reply)=>{const bytes=await control.captureContent(ComputerCaptureContentRequestSchema.parse(request.body));return reply.type('image/png').header('cache-control','no-store').header('x-outlive-content-sha256','sha256:'+createHash('sha256').update(bytes).digest('hex')).send(Buffer.from(bytes));});
}
