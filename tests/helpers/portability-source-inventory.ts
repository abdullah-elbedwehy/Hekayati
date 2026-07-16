import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import ts from "typescript";

export interface ProductionSource {
  readonly path: string;
  readonly text: string;
  readonly ast: ts.SourceFile;
}

export interface SourceFinding {
  readonly path: string;
  readonly line: number;
}

export interface DocumentRepositoryFinding extends SourceFinding {
  readonly collection: string | null;
}

export interface JobTypeFinding extends SourceFinding {
  readonly jobType: string;
}

const documentMutationPattern =
  /\b(?:INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+documents\b/giu;

export async function loadProductionSources(
  workspaceRoot: string,
): Promise<ProductionSource[]> {
  const absoluteRoot = resolve(workspaceRoot);
  const sourceRoot = resolve(absoluteRoot, "src");
  const files = await typescriptFiles(sourceRoot);
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(file, "utf8");
      return {
        path: normalize(relative(absoluteRoot, file)),
        text,
        ast: ts.createSourceFile(
          file,
          text,
          ts.ScriptTarget.Latest,
          true,
          file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        ),
      };
    }),
  );
}

export function documentMutationSources(
  sources: readonly ProductionSource[],
): SourceFinding[] {
  const findings: SourceFinding[] = [];
  for (const source of sources) {
    documentMutationPattern.lastIndex = 0;
    for (const match of source.text.matchAll(documentMutationPattern))
      findings.push(finding(source, match.index));
  }
  return findings;
}

export function documentRepositorySources(
  sources: readonly ProductionSource[],
): DocumentRepositoryFinding[] {
  const findings: DocumentRepositoryFinding[] = [];
  for (const source of sources)
    visit(source.ast, (node) => {
      if (
        !ts.isNewExpression(node) ||
        !ts.isIdentifier(node.expression) ||
        node.expression.text !== "DocumentRepository"
      )
        return;
      const collection = node.arguments?.[1];
      findings.push({
        ...finding(source, node.getStart(source.ast)),
        collection:
          collection && ts.isStringLiteralLike(collection)
            ? collection.text
            : null,
      });
    });
  return findings;
}

export function documentMigrationSources(
  sources: readonly ProductionSource[],
): SourceFinding[] {
  const findings: SourceFinding[] = [];
  for (const source of sources)
    visit(source.ast, (node) => {
      if (!ts.isCallExpression(node)) return;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "migrateDocuments"
      )
        findings.push(finding(source, node.getStart(source.ast)));
    });
  return findings;
}

export function declaredJobTypes(
  sources: readonly ProductionSource[],
): JobTypeFinding[] {
  const findings: JobTypeFinding[] = [];
  for (const source of sources)
    visit(source.ast, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node.name) === "jobType"
      )
        for (const jobType of assignedStrings(node.initializer))
          findings.push({
            ...finding(source, node.initializer.getStart(source.ast)),
            jobType,
          });
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        /jobtypes$/iu.test(node.name.text) &&
        node.initializer
      ) {
        const array = arrayLiteral(node.initializer);
        if (!array) return;
        for (const element of array.elements)
          if (ts.isStringLiteralLike(element))
            findings.push({
              ...finding(source, element.getStart(source.ast)),
              jobType: element.text,
            });
      }
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression))
        return;
      if (!/jobregistration$/iu.test(node.expression.text)) return;
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument))
        findings.push({
          ...finding(source, argument.getStart(source.ast)),
          jobType: argument.text,
        });
    });
  return uniqueJobTypeFindings(findings);
}

function arrayLiteral(
  expression: ts.Expression,
): ts.ArrayLiteralExpression | null {
  if (ts.isArrayLiteralExpression(expression)) return expression;
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  )
    return arrayLiteral(expression.expression);
  return null;
}

function assignedStrings(expression: ts.Expression): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isParenthesizedExpression(expression))
    return assignedStrings(expression.expression);
  if (ts.isConditionalExpression(expression))
    return [
      ...assignedStrings(expression.whenTrue),
      ...assignedStrings(expression.whenFalse),
    ];
  return [];
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    ? name.text
    : null;
}

function finding(source: ProductionSource, offset: number): SourceFinding {
  return {
    path: source.path,
    line: source.ast.getLineAndCharacterOfPosition(offset).line + 1,
  };
}

function uniqueJobTypeFindings(
  findings: readonly JobTypeFinding[],
): JobTypeFinding[] {
  const seen = new Set<string>();
  return findings.filter((item) => {
    const key = `${item.path}\0${item.line}\0${item.jobType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  node.forEachChild((child) => visit(child, inspect));
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return /\.tsx?$/u.test(entry.name) ? [path] : [];
    }),
  );
  return files.flat().sort();
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}
