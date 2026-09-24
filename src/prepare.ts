/**
 * State preparation: deterministic edits applied to a chunk before Jev sees
 * it. When code can already tell that a construct is out of a rule's scope,
 * remove it instead of asking Jev to reason around it — "every X is only
 * inside Y" is a universal, negation-heavy judgment models answer poorly,
 * and one AST pass answers exactly. Line count is preserved so reported
 * ranges stay true. Exported from the `@hazymoon/jevlint/prepare` subpath.
 */
import ts from 'typescript';

/** Replace every call whose callee text matches with a placeholder, keeping the newlines it spanned. */
export function blankCalls(text: string, callee: RegExp, placeholder: string): string {
    const source = ts.createSourceFile('chunk.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const spans: Array<{ start: number; end: number }> = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && callee.test(node.expression.getText(source))) {
            spans.push({ start: node.getStart(source), end: node.getEnd() });
            return;
        }
        node.forEachChild(visit);
    };
    visit(source);
    let result = text;
    for (const span of spans.sort((a, b) => b.start - a.start)) {
        const newlines = '\n'.repeat(result.slice(span.start, span.end).split('\n').length - 1);
        result = `${result.slice(0, span.start)}${placeholder}${newlines}${result.slice(span.end)}`;
    }
    return result;
}

/**
 * Blank every comment while keeping the line count. A stale doc comment that
 * still describes compliant behaviour can talk a model out of a true
 * violation; rules about what code does, not what it says, should judge
 * without them.
 */
export function blankComments(text: string): string {
    const source = ts.createSourceFile('prepare.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const ranges = new Map<number, number>();
    const collect = (node: ts.Node): void => {
        for (const range of [...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []), ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? [])]) { ranges.set(range.pos, range.end); }
        node.forEachChild(collect);
    };
    collect(source);
    let result = text;
    for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
        result = result.slice(0, start) + result.slice(start, end).replace(/[^\n]/g, ' ') + result.slice(end);
    }
    return result;
}
