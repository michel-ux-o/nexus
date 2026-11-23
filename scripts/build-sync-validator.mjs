import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Compile the exact browser backup validator for Node; never maintain a second,
// weaker schema on the server. CommonJS keeps its relative imports Node-safe.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.work/sync-validator');
const program = ts.createProgram([resolve(root, 'src/data/workspaceBackup.ts')], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  rootDir: resolve(root, 'src'), outDir,
  strict: true, skipLibCheck: true, noEmitOnError: true, types: [],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root,
    getCanonicalFileName: value => value,
    getNewLine: () => '\n',
  }));
  process.exitCode = 1;
} else {
  const emitted = program.emit();
  if (emitted.emitSkipped) {
    console.error('Die gemeinsame Workspace-Validierung konnte nicht erstellt werden.');
    process.exitCode = 1;
  } else {
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, 'package.json'), '{"type":"commonjs"}\n');
  }
}
