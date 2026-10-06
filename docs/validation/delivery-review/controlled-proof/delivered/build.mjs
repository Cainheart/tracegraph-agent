import {mkdirSync,copyFileSync} from 'node:fs';mkdirSync('dist',{recursive:true});copyFileSync('src/clamp.mjs','dist/clamp.mjs');console.log('ACTUAL_BUILD_OUTPUT');
