import type { JevRule } from '../src/types.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AstGrepRuleError, findAstMatches, validateAstGrepRule } from '../src/astGrep.js';
import { buildCandidateText, candidateMapsForText, findMatches, selectRelated } from '../src/candidates.js';
import { JevcheckConfigError, resolveConfig } from '../src/config.js';

function rule(candidates: JevRule['candidates']): JevRule {
    return { id: 'demo/rule', severity: 'warning', status: 'owned', why: 'w', files: ['**/*'], question: 'q', criteria: { true: 't', false: 'f' }, fix: 'f', candidates };
}

describe('findAstMatches', () => {
    it('returns 1-based line spans and single-node captures, but not $$$ lists or $_ wildcards', () => {
        const text = 'const a = 1;\nlog.info(user, { a: 1 });\nlog.warn(order, 2, 3);\n';
        const matches = findAstMatches('pattern: log.$LEVEL($ARG, $$$REST)', text, 'typescript');
        expect(matches).toEqual([
            { startLine: 2, endLine: 2, meta: { LEVEL: 'info', ARG: 'user' } },
            { startLine: 3, endLine: 3, meta: { LEVEL: 'warn', ARG: 'order' } },
        ]);
        expect(findAstMatches('pattern: log.info($_X, $$$)', text, 'typescript')[0]?.meta).toEqual({});
    });

    it('supports relational rules (inside / has with stopBy) and multi-line spans', () => {
        const text = [
            'for (const id of ids) {',
            '    await db.load(id);',
            '}',
            'await db.load(other);',
        ].join('\n');
        const inLoop = findAstMatches('pattern: await db.load($ID)\ninside:\n  kind: for_in_statement\n  stopBy: end', text, 'typescript');
        expect(inLoop).toEqual([{ startLine: 2, endLine: 2, meta: { ID: 'id' } }]);
        const loops = findAstMatches('kind: for_in_statement\nhas:\n  pattern: await $CALL($$$)\n  stopBy: end', text, 'typescript');
        expect(loops).toEqual([{ startLine: 1, endLine: 3, meta: { CALL: 'db.load' } }]);
    });

    it('captures a metavariable bound inside an optional any: branch, and omits it when that branch did not bind', () => {
        const text = 'const rows = await load();\nfor (const row of rows) {}\nfor (const x of other) {}\n';
        const yaml = 'kind: for_in_statement\nany:\n  - all:\n      - has: { field: right, pattern: $LIST }\n      - follows: { pattern: const $LIST = await $LOAD(), stopBy: end }\n  - kind: for_in_statement';
        expect(findAstMatches(yaml, text, 'typescript')).toEqual([
            { startLine: 2, endLine: 2, meta: { LIST: 'rows', LOAD: 'load' } },
            { startLine: 3, endLine: 3, meta: {} },
        ]);
    });

    it('parses .tsx as TSX', () => {
        const text = 'export function A() {\n    console.log(props);\n    return <div>{props.x}</div>;\n}\n';
        expect(findAstMatches('pattern: console.log($A)', text, 'tsx')).toEqual([{ startLine: 2, endLine: 2, meta: { A: 'props' } }]);
    });

    it('rejects invalid YAML and invalid rules with AstGrepRuleError', () => {
        expect(() => validateAstGrepRule('pattern: [unclosed')).toThrow(AstGrepRuleError);
        expect(() => validateAstGrepRule('- pattern: a')).toThrow(/YAML mapping/);
        expect(() => validateAstGrepRule('kind: not_a_real_node_kind')).toThrow(AstGrepRuleError);
    });
});

describe('candidates over files and text', () => {
    it('reads the <script> block of a .vue file with true line numbers and keeps only outermost matches', () => {
        const dir = mkdtempSync(join(tmpdir(), 'jevcheck-astgrep-'));
        try {
            writeFileSync(join(dir, 'A.vue'), '<template>\n  <p>{{ console.log(x) }}</p>\n</template>\n<script setup lang="ts">\nconsole.log(fmt(\n    console.log(y),\n));\n</script>\n');
            writeFileSync(join(dir, 'b.md'), 'console.log(z)\n');
            const found = findMatches(dir, 'pattern: console.log($A)', ['A.vue', 'b.md']);
            expect([...found]).toEqual([['A.vue', [{ startLine: 5, endLine: 7, meta: { A: 'fmt(\n    console.log(y),\n)' } }]]]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('links a far-away related construct through linkBy and splices it in as labelled context', () => {
        const lines = [
            'function loadDue() {',
            '    return db.select().from(jobs).orderBy(jobs.due);',
            '}',
            ...Array.from({ length: 40 }, (_, index) => `// filler ${index}`),
            'export async function run() {',
            '    for (const job of await loadDue()) {',
            '        await handle(job);',
            '    }',
            '}',
        ];
        const text = lines.join('\n');
        const demo = rule({
            rule: 'kind: for_in_statement\nhas:\n  pattern: await $LOADER()\n  stopBy: end',
            related: { rule: 'kind: function_declaration\nhas:\n  field: name\n  pattern: $LOADER', linkBy: 'LOADER', label: 'Definition of the loader' },
        });
        const maps = candidateMapsForText(demo, 'src/jobs.ts', text);
        const [candidate] = maps.candidates.get(demo)!.get('src/jobs.ts')!;
        const related = maps.related.get(demo)!.get('src/jobs.ts')!;
        expect(candidate).toEqual({ startLine: 45, endLine: 47, meta: { LOADER: 'loadDue' } });
        expect(selectRelated(candidate!, related, demo.candidates!.related!).map(item => item.startLine)).toEqual([1]);
        const built = buildCandidateText(lines, '', candidate!, 0, 0, { config: demo.candidates!.related!, matches: related });
        expect(built.text).toContain('// --- Definition of the loader ---\nfunction loadDue() {');
        expect(built).toMatchObject({ startLine: 45, endLine: 47 });
    });

    it('returns no candidates for a file type ast-grep does not read', () => {
        const demo = rule({ rule: 'pattern: console.log($A)' });
        expect(candidateMapsForText(demo, 'notes.md', 'console.log(1)').candidates.get(demo)!.get('notes.md')).toEqual([]);
    });
});

describe('config validation of candidate rules', () => {
    it('names the rule and field of an invalid ast-grep rule', () => {
        expect(() => resolveConfig({ rules: [rule({ rule: 'kind: not_a_real_node_kind' })] }, '/project')).toThrow(JevcheckConfigError);
        expect(() => resolveConfig({ rules: [rule({ rule: 'pattern: a', related: { rule: 'pattern: [', label: 'x' } })] }, '/project')).toThrow(/"demo\/rule"\): "candidates.related.rule" is not a valid ast-grep rule/);
        expect(() => resolveConfig({ rules: [rule({ rule: 'pattern: a', related: { rule: 'pattern: b', label: 'x', linkBy: '$NAME' } })] }, '/project')).toThrow(/linkBy/);
    });
});
