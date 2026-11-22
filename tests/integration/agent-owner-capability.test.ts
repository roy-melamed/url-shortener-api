import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { ownerFixture } from '../helpers/owner-recommendation-fixture.ts';

it('imports and executes with only deterministic hashing; all external capabilities denied', () => {
  const source = readFileSync(
    new URL('../../scripts/agent-owner-recommendation.ts', import.meta.url),
    'utf8',
  );
  const ast = ts.createSourceFile('planner.ts', source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function inspect(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      imports.push((node.moduleSpecifier as ts.StringLiteral).text);
      expect(node.importClause?.namedBindings?.getText(ast)).toBe('{ createHash }');
    }
    if (ts.isIdentifier(node))
      expect(
        [
          'process',
          'fetch',
          'WebSocket',
          'XMLHttpRequest',
          'setTimeout',
          'setInterval',
          'setImmediate',
          'queueMicrotask',
          'require',
          'eval',
          'Function',
          'localStorage',
          'globalThis',
        ].includes(node.text),
      ).toBe(false);
    if (ts.isCallExpression(node))
      expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
    if (ts.isPropertyAccessExpression(node)) expect(node.getText(ast)).not.toBe('Date.now');
    ts.forEachChild(node, inspect);
  }
  inspect(ast);
  expect(imports).toEqual(['node:crypto']);
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let denied = 0;
  const fail = () => {
    denied++;
    throw new Error('capability-denied');
  };
  const output = {};
  const sandbox: Record<string, unknown> = {
    exports: output,
    module: { exports: output },
    fixtureJson: JSON.stringify(ownerFixture()),
    require(name: string) {
      if (name !== 'node:crypto') return fail();
      return Object.freeze({ createHash });
    },
  };
  for (const name of [
    'process',
    'fetch',
    'console',
    'WebSocket',
    'XMLHttpRequest',
    'setTimeout',
    'setInterval',
    'setImmediate',
    'queueMicrotask',
    'performance',
    'localStorage',
  ])
    Object.defineProperty(sandbox, name, { get: fail });
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  runInContext(code, context, { timeout: 1000 });
  const result = runInContext(
    `(() => {
    const f = JSON.parse(fixtureJson);
    const before = JSON.stringify(f);
    const baseline = exports.baselineOwnerRecommendations(f.config, f.state.fence, []);
    const plan = exports.recommendAgentOwner(f.config, baseline.state, f.event, f.current, 'ryan');
    const fresh = exports.ownerRecommendationStillCurrent(plan.proposal, f.config, plan.state, f.current);
    const replay = exports.recommendAgentOwner(f.config, plan.state, f.event, f.current, 'ryan');
    const invalid = exports.recommendAgentOwner({secret:'PRIVATE'}, plan.state, f.event, f.current, 'ryan');
    return JSON.stringify({kind:plan.kind, fresh, replay:replay.reason, invalid, unchanged:before === JSON.stringify(f)});
  })()`,
    context,
    { timeout: 1000 },
  );
  expect(JSON.parse(result)).toEqual({
    kind: 'recommendation',
    fresh: true,
    replay: 'duplicate-event',
    invalid: { kind: 'hold', reason: 'invalid-input' },
    unchanged: true,
  });
  expect(denied).toBe(0);
  // This checks the closed module/import boundary, not an OS sandbox or actor identity.
});
