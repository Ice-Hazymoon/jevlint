/**
 * AST-level mutation helpers for recall probes (`jevlint recall`). A mutant
 * must turn real compliant code into a REAL violation and leave the file
 * parseable; a regex that half-deletes a multi-line call produces noise, not
 * a recall probe. Every helper returns null when the file offers nothing to
 * mutate. Exported from the `@hazymoon/jevlint/mutate` subpath so rule authors can
 * reuse them instead of hand-rolling AST edits for every rule.
 */
import ts from 'typescript';

export interface Edit { start: number; end: number; text: string }

export function parse(text: string): ts.SourceFile {
    return ts.createSourceFile('mutant.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

export function applyEdits(text: string, edits: readonly Edit[]): string | null {
    if (edits.length === 0) { return null; }
    let result = text;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }
    return result === text ? null : result;
}

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
    visit(node);
    node.forEachChild(child => walk(child, visit));
}

export function isLoop(node: ts.Node): node is ts.IterationStatement {
    return ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node) || ts.isWhileStatement(node);
}

/** The edit that replaces a try/catch with the bare statements of its try block, or undefined when there is nothing to unwrap. */
function unwrapEdit(text: string, source: ts.SourceFile, statement: ts.Statement): Edit | undefined {
    if (!ts.isTryStatement(statement) || !statement.catchClause) { return undefined; }
    const first = statement.tryBlock.statements.at(0);
    const last = statement.tryBlock.statements.at(-1);
    return first && last ? { start: statement.getStart(source), end: statement.getEnd(), text: text.slice(first.getStart(source), last.getEnd()) } : undefined;
}

/** Replace every try/catch that sits directly in a loop body with the bare contents of its try block. */
export function unwrapTryInLoops(text: string): string | null {
    const source = parse(text);
    const edits: Edit[] = [];
    walk(source, (node) => {
        if (!isLoop(node) || !ts.isBlock(node.statement)) { return; }
        edits.push(...node.statement.statements.flatMap(statement => unwrapEdit(text, source, statement) ?? []));
    });
    // Nested edits would overlap; keep the outermost of any overlapping pair.
    const outer = edits.filter(edit => !edits.some(other => other !== edit && other.start <= edit.start && other.end >= edit.end));
    return applyEdits(text, outer);
}

/**
 * Inside a function whose call site matches `functionCallPattern`, turn the `throw` of each
 * top-level catch clause into `replacement` — a probe for "errors must be reported as a typed
 * result instead of thrown" style rules. Skips a catch nested inside a loop, since a per-item
 * catch legitimately handling one row is a different construct than the function's own error path.
 */
export function catchThrowToTypedReturn(text: string, functionCallPattern: RegExp, replacement: string): string | null {
    if (!functionCallPattern.test(text)) { return null; }
    const source = parse(text);
    const edits: Edit[] = [];
    walk(source, (node) => {
        if (!ts.isCatchClause(node)) { return; }
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
            if (isLoop(parent)) { return; }
        }
        for (const statement of node.block.statements) {
            if (ts.isThrowStatement(statement)) { edits.push({ start: statement.getStart(source), end: statement.getEnd(), text: replacement }); }
        }
    });
    return applyEdits(text, edits);
}

/** Insert a statement at the top of the first loop body that awaits something. */
export function insertAtTopOfFirstAwaitingLoop(text: string, statementText: string): string | null {
    const source = parse(text);
    let edit: Edit | null = null;
    walk(source, (node) => {
        if (edit || !isLoop(node) || !ts.isBlock(node.statement) || node.statement.statements.length === 0) { return; }
        if (!/\bawait\b/.test(node.statement.getText(source))) { return; }
        const first = node.statement.statements[0];
        if (!first) { return; }
        const indent = /[ \t]*$/.exec(text.slice(0, first.getStart(source)))?.[0] ?? '';
        edit = { start: first.getStart(source), end: first.getStart(source), text: `${statementText}\n${indent}` };
    });
    return edit ? applyEdits(text, [edit]) : null;
}

/** Add a property to the object literal passed to the first matching call, e.g. the first `log.info({...})`. */
export function addPropertyToFirstCallObject(text: string, callee: RegExp, property: string): string | null {
    const source = parse(text);
    let edit: Edit | null = null;
    walk(source, (node) => {
        if (edit || !ts.isCallExpression(node) || !callee.test(node.expression.getText(source))) { return; }
        const argument = node.arguments[0];
        if (!argument || !ts.isObjectLiteralExpression(argument) || argument.properties.length === 0) { return; }
        const first = argument.properties[0];
        if (!first) { return; }
        edit = { start: first.getStart(source), end: first.getStart(source), text: `${property}, ` };
    });
    return edit ? applyEdits(text, [edit]) : null;
}

/** Remove every call to the named method from method chains, keeping the rest of the chain — e.g. dropping every `.limit(...)`. */
export function dropMethodCalls(text: string, methodName: string): string | null {
    const source = parse(text);
    const edits: Edit[] = [];
    walk(source, (node) => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== methodName) { return; }
        edits.push({ start: node.expression.expression.getEnd(), end: node.getEnd(), text: '' });
    });
    return applyEdits(text, edits);
}

/** Prefix the first awaited call of a given callee with `void` instead of `await`. */
export function awaitToVoid(text: string, callee: RegExp): string | null {
    const source = parse(text);
    let edit: Edit | null = null;
    walk(source, (node) => {
        if (edit || !ts.isAwaitExpression(node) || !ts.isExpressionStatement(node.parent)) { return; }
        if (!ts.isCallExpression(node.expression) || !callee.test(node.expression.expression.getText(source))) { return; }
        edit = { start: node.getStart(source), end: node.expression.getStart(source), text: 'void ' };
    });
    return edit ? applyEdits(text, [edit]) : null;
}

/** Name of the nearest named function (declaration, or arrow function assigned to a variable) enclosing `node`. */
function enclosingFunctionName(node: ts.Node): string | undefined {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (ts.isFunctionDeclaration(parent) && parent.name) { return parent.name.text; }
        if (ts.isVariableDeclaration(parent) && parent.initializer && ts.isArrowFunction(parent.initializer) && ts.isIdentifier(parent.name)) { return parent.name.text; }
    }
    return undefined;
}

/**
 * Probe for "a call must not feed a list-mapping caller" style rules: finds a call matching
 * `calleePattern` that passes `isEligible` (when given), then appends a synthetic function at the
 * end of the file that maps a list of rows through it — injected as a distant sibling so only a
 * `candidates.related` mechanism (a same-file caller can be arbitrarily far from what it calls)
 * can connect it back to the primary candidate. The matched call site's own text never changes.
 */
export function appendSyntheticListCaller(text: string, calleePattern: RegExp, isEligible: (call: ts.CallExpression, source: ts.SourceFile) => boolean, newFunctionName: (calleeName: string) => string): string | null {
    const source = parse(text);
    let name: string | undefined;
    walk(source, (node) => {
        if (name || !ts.isCallExpression(node) || !calleePattern.test(node.expression.getText(source)) || !isEligible(node, source)) { return; }
        name = enclosingFunctionName(node);
    });
    if (!name) { return null; }
    const listFnName = newFunctionName(name);
    if (new RegExp(`\\.map\\s*\\(\\s*\\w*\\s*(?::\\s*\\w+\\s*)?=>\\s*${name}\\s*\\(`).test(text)) { return null; }
    return `${text}\n\nexport async function ${listFnName}(ownerId: string): Promise<unknown[]> {\n    const rows = await loadRowsForOwner(ownerId);\n    return rows.map(row => ${name}(row));\n}\n`;
}

/** Replace a single-argument call to `calleeName` with `replacement(argumentText)`, but only inside a loop or an array-iteration callback (map/flatMap/forEach/reduce/filter). */
export function replaceCallInIterationScope(text: string, calleeName: string, replacement: (argumentText: string) => string): string | null {
    const source = parse(text);
    const edits: Edit[] = [];
    const isIterationCallback = (node: ts.Node): boolean => (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
        && ts.isCallExpression(node.parent) && ts.isPropertyAccessExpression(node.parent.expression)
        && /^(?:map|flatMap|forEach|reduce|filter)$/.test(node.parent.expression.name.text);
    walk(source, (node) => {
        if (!ts.isCallExpression(node) || node.expression.getText(source) !== calleeName || node.arguments.length !== 1) { return; }
        const argument = node.arguments[0];
        if (!argument || !(ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument))) { return; }
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
            if (isLoop(parent) || isIterationCallback(parent)) {
                edits.push({ start: node.getStart(source), end: node.getEnd(), text: replacement(argument.getText(source)) });
                return;
            }
        }
    });
    return applyEdits(text, edits);
}
