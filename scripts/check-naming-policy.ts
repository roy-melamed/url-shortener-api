/** Conservative declaration guard, not a general semantic naming validator.
 * Read-only; no Docker/database/cloud access. See the normative policy for scope.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export interface Finding {
  file: string;
  line: number;
  identifier: string;
}
// Registered project key only: inferring keys from every word-number pair
// would misclassify postgres-16 / sha-256 / region and version names.
const jira = /(?:^|[^a-z0-9])url-\d+(?=$|[^a-z0-9])/i;
const legacy = /(?:^|[^a-z0-9])(?:url8-pg|url8_acceptance|url27-backup|ryan-url8)(?=$|[^a-z0-9])/i;
const field =
  /^(?:name|id|container_name|image|database|schema|table|volume|network|namespace|path|resource|resourceName|stackName|bucketName|queueName|functionName|serviceName|databaseName|dbProxyName|tableName|domainName|hostedZoneName|logGroupName|POSTGRES_DB|PGDATABASE|DB_NAME|DATABASE_NAME|CONTAINER_NAME|IMAGE_NAME|VOLUME_NAME|NETWORK_NAME|SCRIPT_NAME|BACKUP_DATABASES|OCI_BUCKET|SyslogIdentifier)$/i;

// Exact pre-existing declaration only; not a blanket exemption for this name
// elsewhere, nor for adding another occurrence in this file.
const compatibility = new Map([
  [
    'scripts/postgres-backup.sh',
    new Set([
      'BACKUP_DATABASES="${BACKUP_DATABASES:-urlshortener url8_acceptance}"',
      'SCRIPT_NAME="url27-backup"',
    ]),
  ],
  [
    'deploy/systemd/url-shortener-postgres-backup.service',
    new Set(['SyslogIdentifier=url27-backup']),
  ],
]);

export function activeFile(file: string): boolean {
  return (
    !/^(?:docs|specs|tests|\.opencode|node_modules|dist|coverage|cdk\.out)\//.test(file) &&
    /(?:\.(?:ts|js|mjs|json|ya?ml|sh|sql|env|service|timer)|(?:^|\/)\.env(?:\.example)?)$/.test(
      file,
    )
  );
}

export function checkSource(file: string, text: string): Finding[] {
  if (!activeFile(file)) return [];
  const findings: Finding[] = [];
  const allowedOccurrences = new Set<string>();
  const add = (value: string, pos: number): void => {
    if (!jira.test(value) && !legacy.test(value)) return;
    const line = text.slice(0, pos).split('\n').length;
    const declaration = text.split('\n')[line - 1]?.trim() ?? '';
    if (compatibility.get(file)?.has(declaration) && !allowedOccurrences.has(declaration)) {
      allowedOccurrences.add(declaration);
      return;
    }
    findings.push({ file, line, identifier: value });
  };

  if (/\.(?:ts|js|mjs|json)$/.test(file)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const literal = (node: ts.Node | undefined): void => {
      if (node && ts.isStringLiteralLike(node)) add(node.text, node.getStart(source));
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        field.test(node.name.getText(source).replace(/['"]/g, ''))
      )
        literal(node.initializer);
      if (ts.isVariableDeclaration(node) && field.test(node.name.getText(source)))
        literal(node.initializer);
      // Construct IDs (second argument) and declared code identifiers.
      if (ts.isNewExpression(node)) literal(node.arguments?.[1]);
      // Migrations declare durable schema identities; never execute them.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        /^(?:createTable|createSchema|createIndex|addConstraint|createType|createSequence|renameTable|renameSchema|renameIndex)$/.test(
          node.expression.name.text,
        )
      ) {
        for (const arg of node.arguments) literal(arg);
      }
      if ((ts.isClassDeclaration(node) || ts.isModuleDeclaration(node)) && node.name)
        add(node.name.getText(source), node.name.getStart(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
  } else {
    let offset = 0;
    for (const line of text.split('\n')) {
      if (!/^\s*(?:#|--|;)/.test(line)) {
        // Scalar YAML / shell / env / systemd declarations. Mapping keys
        // matching an issue token also count (e.g. Compose service names).
        const decl = line.match(/^\s*([\w.-]+)\s*[:=]\s*(.*)$/);
        if (decl) {
          const key = decl[1]!;
          const value = decl[2]!.replace(/\s+#.*$/, '');
          if (jira.test(key) || legacy.test(key)) add(key, offset);
          if (
            field.test(key) ||
            /(?:_NAME|_DATABASE|_SCHEMA|_TABLE|_CONTAINER|_IMAGE|_VOLUME|_NETWORK|_NAMESPACE)$/.test(
              key,
            )
          )
            add(value, offset);
        }
        // Explicit resource creation in operational scripts / new SQL only.
        const resource =
          /(?:\bCREATE\s+(?:UNIQUE\s+)?(?:DATABASE|SCHEMA|TABLE|INDEX)\s+(?:IF NOT EXISTS\s+)?["`]?([\w.-]+)|(?:^|\s)--name\s+['"]?([\w.-]+))/gi;
        for (const match of line.matchAll(resource)) add(match[1] ?? match[2]!, offset);
      }
      offset += line.length + 1;
    }
  }
  return findings;
}

export function checkRepository(root: string): Finding[] {
  const paths = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  );
  return [...new Set(paths.split('\0').filter(Boolean))]
    .sort()
    .flatMap((file) =>
      activeFile(file) ? checkSource(file, readFileSync(resolve(root, file), 'utf8')) : [],
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const findings = checkRepository(process.cwd());
  for (const f of findings)
    console.error(`${f.file}:${f.line}: forbidden persistent identifier ${f.identifier}`);
  console.log(`Naming declaration check: ${findings.length} violation(s)`);
  process.exitCode = findings.length ? 1 : 0;
}
