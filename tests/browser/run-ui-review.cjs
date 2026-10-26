// Run sequentially: every browser scenario resets the same isolated server.
const { spawnSync } = require('node:child_process');
const allSuites = [
  'ui-review', 'editor', 'workspace-layout', 'ai-models', 'project-words',
  'dialogue-structure', 'dialogue-ai', 'dictate-draft', 'draft-audio', 'draft-import',
  'ocr-import', 'ocr-feedback', 'ocr-hosted', 'ocr-frames', 'wiki-ai', 'wiki-instruction',
  'wiki-links', 'annotations', 'annotation-tooltips', 'question-context',
  'wording-alternatives', 'revisions', 'scene-metadata', 'server-connection',
  'workspace-tips', 'dictation', 'observations', 'editing-spaces', 'smoke',
  'project-features', 'world-authoring', 'fingal-transfer', 'speed-reader',
  'thesaurus', 'comments', 'find-replace', 'storage-safety',
  'ui-review-followup', 'project-files',
];
const requested = process.argv.slice(2);
if (requested.some(name => !allSuites.includes(name))) throw new Error('Unknown UI review suite');
const suites = requested.length ? requested : allSuites;
const failed = [];
for (const suite of suites) {
  const run = spawnSync(process.execPath, [`${__dirname}/${suite}.cjs`], { encoding: 'utf8', timeout: 180000, env: process.env });
  if (run.status !== 0) { failed.push(suite); console.error(`FAIL ${suite}\n${run.stdout || ''}${run.stderr || ''}${run.error || ''}`); }
  else console.log(`PASS ${suite}`);
}
console.log(`UI review: ${suites.length - failed.length}/${suites.length} suites passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}.`);
process.exitCode = failed.length ? 1 : 0;
