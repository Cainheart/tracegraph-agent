import {describe,it,expect} from "vitest";
import {StartRunRequestSchema} from "./commands.js";
import {SessionRunOptionsOverrideSchema,SessionRunOptionsUpdateRequestSchema} from "./conversation-options.js";
import {UpdateWorkbenchSettingsRequestSchema} from "./local-workbench.js";

describe("configuration omission and authority contracts",()=>{
 it("does not insert reasoning or permission defaults into explicit model-only selection",()=>{expect(StartRunRequestSchema.parse({command_id:"command",project_id:"project",task:"task",mode:"execute",run_options:{connection_id:"saved"}}).run_options).toEqual({connection_id:"saved"});expect(SessionRunOptionsOverrideSchema.parse({mode:"plan"})).toEqual({mode:"plan"});});
 it("preserves omitted settings fields while rejecting undeclared input",()=>{expect(UpdateWorkbenchSettingsRequestSchema.parse({command_id:"command",expected_revision:0,patch:{general:{notify_failed:false}}}).patch).toEqual({general:{notify_failed:false}});expect(UpdateWorkbenchSettingsRequestSchema.safeParse({command_id:"command",expected_revision:0,patch:{model:{api_key:"synthetic"}}}).success).toBe(false);});
 it("requires one explicit options or overrides representation and excludes credentials",()=>{expect(SessionRunOptionsUpdateRequestSchema.safeParse({command_id:"command",expected_revision:0}).success).toBe(false);expect(SessionRunOptionsUpdateRequestSchema.safeParse({command_id:"command",expected_revision:0,overrides:{api_key:"synthetic"}}).success).toBe(false);expect(SessionRunOptionsUpdateRequestSchema.parse({command_id:"command",expected_revision:0,overrides:{}}).overrides).toEqual({});});
});
