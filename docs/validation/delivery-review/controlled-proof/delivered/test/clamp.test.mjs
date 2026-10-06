import assert from 'node:assert/strict'; import {clamp} from '../dist/clamp.mjs'; assert.equal(clamp(12,0,10),10); assert.equal(clamp(-1,0,10),0); assert.equal(clamp(4,0,10),4); assert.throws(()=>clamp(NaN,0,10),TypeError); console.log('ACTUAL_CLAMP_TESTS_PASS');
assert.throws(()=>clamp(4,10,0),RangeError); console.log('ACTUAL_REVERSED_RANGE_REGRESSION_PASS');
