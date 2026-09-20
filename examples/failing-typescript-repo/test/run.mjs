import assert from "node:assert/strict";
import { add } from "../src/add.ts";

assert.equal(add(2, 3), 5, "add(2, 3) should equal 5");
assert.equal(add(-2, 2), 0, "add(-2, 2) should equal 0");

console.log("2/2 fixture assertions passed");
