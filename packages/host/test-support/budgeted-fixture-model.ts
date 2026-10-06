import type {ModelAdapter,ModelInput} from '@tracegraph/core';

/** Test-only in-process protocol adapter. Charges bounded serialized fixture units;
 * these synthetic units never represent paid-provider tokenizer or quality evidence. */
export function budgetedFixtureModel(source:ModelAdapter):ModelAdapter{
 return Object.assign(Object.create(source),{
  supportsRequestBudget:true as const,
  forRun:()=>budgetedFixtureModel(source.forRun?.()??source),
  releaseRun:()=>source.releaseRun?.(),
  async decide(input:ModelInput):Promise<unknown>{
   if(!input.requestBudget)return source.decide(input);
   const payload=JSON.stringify({task:input.task,mode:input.mode,context:input.context,observations:input.observations,toolSchemas:input.toolSchemas,rolePrompt:input.rolePrompt});
   const inputTokens=Buffer.byteLength(payload)+1_024;
   const reservation=await input.requestBudget.reserve({runId:input.runId,requestKind:'initial',inputTokens,maxOutputTokens:Math.min(input.maxOutputTokens??2_048,8_192)});
   if(input.signal?.aborted||reservation.signal.aborted){await reservation.cancelBeforeDispatch();throw Object.assign(new Error('Fixture reservation stopped before dispatch'),{code:'goal_budget_stopped'});}
   let settled=false;
   try{
    const result=await source.decide({...input,maxOutputTokens:reservation.maxOutputTokens}),serialized=JSON.stringify(result);
    if(serialized===undefined)throw Error('Fixture result is not serializable');
    const outputTokens=Math.max(1,Buffer.byteLength(serialized));
    if(outputTokens>reservation.maxOutputTokens)throw Object.assign(new Error('Fixture response exceeds reserved output'),{code:'fixture_output_budget_exceeded'});
    const usage={provider:'deterministic-fixture',model:source.name,input_tokens:inputTokens,output_tokens:outputTokens,total_tokens:inputTokens+outputTokens,request_kind:'initial' as const,request_sequence:1};
    await reservation.settle(usage);settled=true;input.onUsage?.(usage);return result;
   }finally{if(!settled)await reservation.settle();}
  },
 });
}
