import type { Candidate } from '../src/candidates.js';
import { describe, expect, it } from 'vitest';
import { appendRelatedContext, buildCandidateText, outermost, selectRelated } from '../src/candidates.js';

describe('outermost', () => {
    it('drops a match nested inside another match, keeps disjoint matches', () => {
        const spans: Candidate[] = [
            { startLine: 1, endLine: 20, meta: {} },
            { startLine: 5, endLine: 10, meta: {} }, // nested inside the first
            { startLine: 30, endLine: 40, meta: {} },
        ];
        const result = outermost(spans);
        expect(result).toHaveLength(2);
        expect(result.map(s => s.startLine).sort((a, b) => a - b)).toEqual([1, 30]);
    });

    it('collapses two equal spans (matched by different any: branches) into one', () => {
        const spans: Candidate[] = [{ startLine: 5, endLine: 5, meta: { X: 'a' } }, { startLine: 5, endLine: 5, meta: { X: 'a' } }];
        expect(outermost(spans)).toHaveLength(1);
    });
});

describe('selectRelated', () => {
    const candidate: Candidate = { startLine: 10, endLine: 12, meta: { CALLEE: 'load' } };
    const related: Candidate[] = [
        { startLine: 50, endLine: 55, meta: { CALLEE: 'load' } },
        { startLine: 5, endLine: 8, meta: { CALLEE: 'load' } },
        { startLine: 60, endLine: 65, meta: { CALLEE: 'other' } },
        { startLine: 10, endLine: 12, meta: { CALLEE: 'load' } }, // the candidate's own span
    ];

    it('links only matches sharing the linkBy capture, nearest line first, excluding the candidate\'s own span', () => {
        const linked = selectRelated(candidate, related, { rule: '', linkBy: 'CALLEE', label: 'x' });
        expect(linked.map(item => item.startLine)).toEqual([5, 50]);
    });

    it('includes every match when linkBy is omitted', () => {
        const linked = selectRelated(candidate, related, { rule: '', label: 'x' });
        expect(linked.map(item => item.startLine)).toEqual([5, 50, 60]);
    });
});

describe('appendRelatedContext', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);

    it('returns the body unchanged when nothing links', () => {
        const candidate: Candidate = { startLine: 1, endLine: 2, meta: {} };
        expect(appendRelatedContext(lines, 'BODY', candidate, [], { rule: '', label: 'x' })).toBe('BODY');
    });

    it('appends a labelled block for a linked match and stops before exceeding maxLines', () => {
        const candidate: Candidate = { startLine: 1, endLine: 2, meta: { X: 'a' } };
        const related: Candidate[] = [{ startLine: 10, endLine: 15, meta: { X: 'a' } }, { startLine: 70, endLine: 79, meta: { X: 'a' } }];
        const result = appendRelatedContext(lines, 'BODY', candidate, related, { rule: '', linkBy: 'X', label: 'Definition', maxLines: 6 });
        expect(result).toContain('--- Definition ---');
        expect(result).toContain('line 10');
        expect(result).not.toContain('line 70');
    });
});

describe('buildCandidateText', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

    it('slices the candidate span with before/after context and prepends the header', () => {
        const candidate: Candidate = { startLine: 10, endLine: 12, meta: {} };
        const built = buildCandidateText(lines, 'HEADER\n', candidate, 2, 2);
        expect(built.startLine).toBe(8);
        expect(built.endLine).toBe(14);
        expect(built.text.startsWith('HEADER\n')).toBe(true);
        expect(built.text).toContain('line 8');
        expect(built.text).toContain('line 14');
        expect(built.text).not.toContain('line 15');
    });

    it('produces byte-identical text to a rule with no related config when related is omitted', () => {
        const candidate: Candidate = { startLine: 5, endLine: 5, meta: {} };
        const withoutRelated = buildCandidateText(lines, '', candidate, 0, 0);
        const withEmptyRelated = buildCandidateText(lines, '', candidate, 0, 0, { config: { rule: '', label: 'x' }, matches: [] });
        expect(withEmptyRelated.text).toBe(withoutRelated.text);
    });
});
