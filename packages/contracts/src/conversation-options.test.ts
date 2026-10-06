import {describe,expect,it} from "vitest";
import {ModelCatalogEntrySchema,resolveModelCatalogEntry} from "./conversation-options.js";

const catalog=[ModelCatalogEntrySchema.parse({id:"deepseek-flash",name:"DeepSeek-V4.1-Flash",capability_status:"confirmed",source:"provider_response",context_window_tokens:1_048_576,max_output_tokens:393_216,input_modalities:["text","image"],output_modalities:["text"],reasoning_efforts:["low","high","max"],reasoning_default:"high"})];

describe("model catalog alias resolution",()=>{
 it("uses the official DeepSeek capability entry for its documented legacy model id",()=>{
  expect(resolveModelCatalogEntry("deepseek-v4-flash",catalog,"deepseek","https://api.deepseek.com/v1")).toBe(catalog[0]);
 });
 it("prefers an exact provider entry and does not infer aliases for compatible proxies",()=>{
  const exact=ModelCatalogEntrySchema.parse({id:"deepseek-v4-flash",capability_status:"unknown",source:"model_id_only"});
  expect(resolveModelCatalogEntry("deepseek-v4-flash",[...catalog,exact],"deepseek","https://api.deepseek.com")).toBe(exact);
  expect(resolveModelCatalogEntry("deepseek-v4-flash",catalog,"deepseek","https://proxy.example/v1")).toBeUndefined();
  expect(resolveModelCatalogEntry("deepseek-v4-flash",catalog,"custom","https://api.deepseek.com/v1")).toBeUndefined();
 });
});
