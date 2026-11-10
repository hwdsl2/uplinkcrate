// Also drives the workflow's fallback cleanup after an interrupted helper.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const failures = Object.freeze([
  'bad-key', 'bad-json', 'collision', 'old-code', 'saved-lf', 'saved-crlf',
  'saved-override', 'bootstrap-collision',
]);
export const cleanups = Object.freeze(['missing', 'file', 'symlink', 'directory', 'bind']);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [kind, scenarios] of [['fail', failures], ['clean', cleanups]]) {
    for (const scenario of scenarios) console.log(`${kind} ${scenario}`);
  }
}
