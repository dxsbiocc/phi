import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import ts from 'typescript'

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/u
const ompTypeRoots = new Set([
  '@oh-my-pi/pi-coding-agent',
  '@oh-my-pi/pi-ai',
  '@oh-my-pi/pi-agent-core'
])
type Reference = { specifier?: string; typeOnly: boolean; staticImport: boolean }

function references(file: string): Reference[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const result: Reference[] = []
  const record = (
    expression: ts.Node | undefined,
    typeOnly: boolean,
    staticImport = false
  ): void => {
    result.push({
      specifier:
        expression &&
        (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
          ? expression.text
          : undefined,
      typeOnly,
      staticImport
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      record(
        node.moduleSpecifier,
        clause?.isTypeOnly === true ||
          (!!clause &&
            !clause.name &&
            !!bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((binding) => binding.isTypeOnly)),
        true
      )
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      record(
        node.moduleSpecifier,
        node.isTypeOnly ||
          (!!node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((binding) => binding.isTypeOnly)),
        true
      )
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression, node.isTypeOnly)
    } else if (ts.isImportTypeNode(node)) {
      record(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true)
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const requireResolve =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'require' &&
        node.expression.name.text === 'resolve'
      if (dynamicImport || requireCall || requireResolve) record(node.arguments[0], false)
    }
    ts.forEachChild(node, visit)
    for (const doc of (node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? []) visit(doc)
  }
  visit(source)
  return result
}

function inside(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

export function extensionPackageFailures(packageRoot: string): string[] {
  const root = realpathSync(packageRoot)
  const failures: string[] = []
  const files: string[] = []
  const seen = new Set<string>()
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const target = realpathSync(path)
      if (!inside(root, target)) {
        failures.push(`${relative(root, path)} escapes package`)
      } else if (!seen.has(target)) {
        seen.add(target)
        if (statSync(target).isDirectory()) walk(target)
        else if (sourceExtension.test(path)) files.push(path)
      }
    }
  }
  walk(root)
  for (const file of files) {
    for (const reference of references(file)) {
      const specifier = reference.specifier
      const label = `${relative(root, file)} -> ${specifier ?? '<nonliteral>'}`
      if (specifier?.startsWith('.')) {
        const target = resolve(dirname(file), specifier)
        const candidates = [
          target,
          ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].flatMap((extension) => [
            `${target}${extension}`,
            resolve(target, `index${extension}`)
          ])
        ]
        // Node-style .js specifiers may refer to TypeScript sources before build.
        if (/\.[cm]?js$/u.test(target)) {
          candidates.push(
            target.slice(0, -extname(target).length) + extname(target).replace('js', 'ts')
          )
        }
        const resolved = candidates.find(
          (candidate) => existsSync(candidate) && statSync(candidate).isFile()
        )
        if (!inside(root, target) || !resolved || !inside(root, realpathSync(resolved)))
          failures.push(label)
      } else if (specifier?.startsWith('node:') && isBuiltin(specifier)) {
        continue
      } else if (specifier && ompTypeRoots.has(specifier) && reference.typeOnly) {
        continue
      } else if (specifier === '@oh-my-pi/pi-ai/utils/event-stream' && reference.staticImport) {
        continue
      } else {
        failures.push(label)
      }
    }
  }
  return failures
}
