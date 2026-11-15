/** Conservative declaration guard, not a general semantic naming validator.
 * Read-only; no Docker/database/cloud access. See the normative policy for scope.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { dockerDeclaration, type DockerDeclaration } from './docker-option-grammar.ts';

export interface Finding {
  file: string;
  line: number;
  identifier: string;
  reason?: string;
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

/** Strip shell/YAML # comments only outside quotes, never a quoted value. */
function withoutComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

/** Ordinary single/double quoted YAML literals; no evaluation/interpolation. */
function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Tokenize simple shell command lists without executing anything. Quoted
 * text stays in one word, comments end the line, unquoted separators split
 * commands. Thus `echo "docker run ..."` is not a docker invocation.
 */
function shellNames(line: string): DockerDeclaration[] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let wordStarted = false;
  let quote = '';
  const finishWord = (): void => {
    if (wordStarted) words.push(word);
    word = '';
    wordStarted = false;
  };
  const finishCommand = (): void => {
    finishWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '\\' && quote !== "'" && i + 1 < line.length) {
      word += line[++i];
      wordStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      wordStarted = true;
      continue;
    }
    if (char === '#' && !wordStarted) break;
    if (';|&'.includes(char)) finishCommand();
    else if (/\s/.test(char)) finishWord();
    else {
      word += char;
      wordStarted = true;
    }
  }
  finishCommand();
  return commands.flatMap((tokens) => {
    // Simple leading assignments / sudo are supported. Dynamic commands,
    // complex wrappers and multiline shell grammar remain semantic review.
    let index = 0;
    while (/^[A-Za-z_][\w]*=/.test(tokens[index] ?? '')) index++;
    if (tokens[index] === 'sudo') {
      index++;
      while (tokens[index]?.startsWith('-')) index++;
    }
    if (!/(?:^|\/)docker$/.test(tokens[index] ?? '')) return [];
    return [dockerDeclaration(tokens.slice(index + 1))];
  });
}

/** SQL tokens distinguish quoted identifiers from string literals/comments.
 * SQL is scanned only in SQL files, never in shell echo/printf prose.
 */
function sqlNames(text: string): { value: string; pos: number }[] {
  const tokens = [
    ...text.matchAll(
      /\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|[\w$-]+|[^\s]/g,
    ),
  ].filter((m) => !m[0].startsWith('--') && !m[0].startsWith('/*'));
  const results: { value: string; pos: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]![0].toUpperCase() !== 'CREATE') continue;
    let next = i + 1;
    if (tokens[next]?.[0].toUpperCase() === 'UNIQUE') next++;
    if (!/^(?:DATABASE|SCHEMA|TABLE|INDEX)$/i.test(tokens[next]?.[0] ?? '')) continue;
    next++;
    if (
      tokens[next]?.[0].toUpperCase() === 'IF' &&
      tokens[next + 1]?.[0].toUpperCase() === 'NOT' &&
      tokens[next + 2]?.[0].toUpperCase() === 'EXISTS'
    )
      next += 3;
    // A target may be schema-qualified and each component can be quoted.
    // Dot is a separate token, not part of a bare identifier; inspect every
    // literal component instead of accepting only the leading schema name.
    while (tokens[next] && /^(?:[A-Za-z_][\w$-]*|"(?:""|[^"])*"|`[^`]*`)$/.test(tokens[next]![0])) {
      const token = tokens[next]!;
      results.push({ value: scalar(token[0]).replace(/^`|`$/g, ''), pos: token.index });
      if (tokens[next + 1]?.[0] !== '.') break;
      next += 2;
    }
  }
  return results;
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
  const inspectShell = (line: string, pos: number): void => {
    for (const declaration of shellNames(line)) {
      for (const name of declaration.names) add(name, pos);
      if (declaration.problem)
        findings.push({
          file,
          line: text.slice(0, pos).split('\n').length,
          identifier: 'docker',
          reason: declaration.problem,
        });
    }
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
  } else if (file.endsWith('.sql')) {
    for (const name of sqlNames(text)) add(name.value, name.pos);
  } else {
    const yaml = /\.ya?ml$/.test(file);
    let runBlockIndent: number | undefined;
    let offset = 0;
    for (const line of text.split('\n')) {
      const indent = line.length - line.trimStart().length;
      if (runBlockIndent !== undefined && line.trim() && indent <= runBlockIndent)
        runBlockIndent = undefined;
      if (!/^\s*(?:#|--|;)/.test(line)) {
        const code = withoutComment(line);
        // YAML permits ordinary quoted mapping keys (including sequence maps).
        // Assignments in shell/env/systemd retain their separate syntax.
        const decl = yaml
          ? code.match(/^\s*(?:-\s+)?("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[\w.-]+)\s*:\s*(.*)$/)
          : code.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
        if (decl) {
          const key = scalar(decl[1]!);
          const value = yaml ? scalar(decl[2]!) : decl[2]!;
          if (jira.test(key) || legacy.test(key)) add(key, offset);
          if (
            field.test(key) ||
            /(?:_NAME|_DATABASE|_SCHEMA|_TABLE|_CONTAINER|_IMAGE|_VOLUME|_NETWORK|_NAMESPACE)$/.test(
              key,
            )
          )
            add(value, offset);
          if (yaml && key === 'run') {
            if (/^[|>][-+]?/.test(value)) runBlockIndent = indent;
            else inspectShell(value, offset);
          }
        }
        if (
          file.endsWith('.sh') ||
          (yaml && runBlockIndent !== undefined && indent > runBlockIndent)
        ) {
          inspectShell(code, offset);
        }
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
    console.error(
      `${f.file}:${f.line}: ${f.reason ? `manual naming review required: ${f.reason}` : `forbidden persistent identifier ${f.identifier}`}`,
    );
  const manual = findings.filter((finding) => finding.reason).length;
  console.log(
    `Naming declaration check: ${findings.length - manual} violation(s)${manual ? `, ${manual} manual-review finding(s)` : ''}`,
  );
  process.exitCode = findings.length ? 1 : 0;
}
