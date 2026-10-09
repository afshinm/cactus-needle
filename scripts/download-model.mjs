import { fileURLToPath } from 'node:url';
import { downloadModel } from '../dist/index.js';

const cacheDir = fileURLToPath(new URL('../.cache/', import.meta.url));
console.log(await downloadModel({ cacheDir }));
console.log(await downloadModel({ cacheDir, model: 'whistle' }));
