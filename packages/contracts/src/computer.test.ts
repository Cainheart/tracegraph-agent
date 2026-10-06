import {describe,expect,it} from "vitest";
import {ComputerGrantRequestSchema,ComputerActionRequestSchema,ComputerCommandReceiptSchema} from "./computer.js";
const target={application_id:"test.app",pid:1,title:"app",identity:"sha256:"+"a".repeat(64),window_id:"2"};
describe("closed computer control contracts",()=>{
 it("rejects self-confirmation and arbitrary helper commands",()=>{expect(ComputerGrantRequestSchema.safeParse({command_id:"id",target,duration:"always",confirmed:true}).success).toBe(false);expect(ComputerActionRequestSchema.safeParse({command_id:"id",lease_id:"lease",expected_generation:0,action:{kind:"exec",command:"shell"}}).success).toBe(false);expect(ComputerActionRequestSchema.safeParse({command_id:"id",lease_id:"lease",expected_generation:0,action:{kind:"key",key:"F12",modifiers:[]}}).success).toBe(false);});
 it("bounds text and requires actual typed receipt results",()=>{expect(ComputerActionRequestSchema.safeParse({command_id:"id",lease_id:"lease",expected_generation:0,action:{kind:"type",text:"x".repeat(4001)}}).success).toBe(false);expect(ComputerCommandReceiptSchema.safeParse({command_id:"id",state:"completed",result:{arbitrary_secret:"forged"}}).success).toBe(false);expect(ComputerCommandReceiptSchema.parse({command_id:"id",state:"unknown",code:"effect_unknown"}).state).toBe("unknown");});
});
