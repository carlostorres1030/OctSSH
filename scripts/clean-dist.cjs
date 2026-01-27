const fs = require('node:fs');
const path = require('node:path');

const distPath = path.join(process.cwd(), 'dist');
fs.rmSync(distPath, { recursive: true, force: true });
