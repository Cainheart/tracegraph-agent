import {describe,expect,it} from "vitest";
import {DecisionSchema,DeliveryReviewResultSchema} from "./index.js";
const review={verdict:"passed",reviewed_paths:["src/value.mjs"],findings:[]};
describe("closed independent delivery report",()=>{
 it("accepts an additive finish result but never a tool-call result",()=>{
  const finish={decision_id:"review:one",kind:"finish",public_reason:"Recorded public code review",risk:"none",final_answer:"No blocking defect",review_result:review};
  expect(DecisionSchema.parse(finish).review_result).toEqual(review);
  expect(DecisionSchema.safeParse({...finish,kind:"tool_call",final_answer:undefined,tool_call:{action_id:"read:one",tool_name:"read_file",arguments:{path:"src/value.mjs"}}}).success).toBe(false);
 });
 it("rejects free-text success, passing blocking findings, unreviewed paths and escaped paths",()=>{
  for(const value of ["passed",{...review,findings:[{severity:"blocking",path:"src/value.mjs",summary:"Actual defect"}]},{...review,verdict:"blocked"},{...review,reviewed_paths:["../private"]},{...review,findings:[{severity:"warning",path:"other.mjs",summary:"Not inspected"}]}])expect(DeliveryReviewResultSchema.safeParse(value).success).toBe(false);
 });
});
