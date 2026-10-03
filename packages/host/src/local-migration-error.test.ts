import {describe,it,expect} from "vitest";
import {LocalMigrationOutcomeError} from "./local-host.js";

describe("native migration reconciliation identity",()=>{
 it.each(["migration_failed","migration_outcome_unknown"] as const)("preserves an inspectable operation identity for %s without private source information",code=>{
  const operation_id="eeaa9970-fda1-4a55-820d-a53ef72c570a";
  const error=new LocalMigrationOutcomeError(code,operation_id);
  expect(error).toMatchObject({name:"LocalMigrationOutcomeError",code,operation_id});
  expect(error.message).toContain("persistent migration receipt before retrying");
  expect(Object.keys(error).sort()).toEqual(["code","name","operation_id"]);
 });
});
