const fs = require('node:fs');
const path = require('node:path');

// Cross-platform test discovery without shell globs.
// Node's `--test` does not accept directories on all platforms/versions.
const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js') && f !== 'index.test.js')
  .sort();

for (const f of files) {
  require(path.join(dir, f));
}
