import type { JevClient } from './client.js';
/**
 * Claim verifier: checks statements about code against the code they cite,
 * before they become findings or review comments. Catches the cheap
 * mistakes — a file that is not there, a quote that is not in it, a claim
 * the cited lines contradict or simply do not address.
 *
 * Code decides what it can (existence, range, quote match); Jev only judges
 * how the cited lines relate to the claim. `supports` means "these lines say
 * so", not "the finding is a real bug" — a caller should still confirm.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Claim {
    id: string;
    file: string;
    /** 1-based inclusive. Omit both to cite the whole file (small files only). */
    startLine?: number;
    endLine?: number;
    /** One falsifiable statement about the cited code. */
    claim: string;
    /** Optional verbatim snippet said to be in the cited range. */
    quote?: string;
}

export interface ClaimVerdict {
    id: string;
    verdict: 'verified' | 'contradicted' | 'unsupported' | 'review' | 'fabricated' | 'invalid';
    confidence: number;
    detail: string;
}

// Compared with the winning option's probability. `confidence` measures how peaked the whole
// distribution is and sits well below the top probability for a clear 0.80 / 0.19 split.
const AUTO_ACCEPT = 0.75;
const CONTEXT_LINES = 12;
const MAX_CITED_LINES = 400;

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

interface Citation { lines: string[]; start: number; end: number; cited: string }

/** What code alone can decide: the file, the range and the quote exist. Returns a verdict, or the cited lines to judge. */
function checkCitation(root: string, claim: Claim): ClaimVerdict | Citation {
    const fail = (verdict: ClaimVerdict['verdict'], detail: string): ClaimVerdict => ({ id: claim.id, verdict, confidence: 1, detail });
    const path = join(root, claim.file);
    if (!existsSync(path)) { return fail('fabricated', `file does not exist: ${claim.file}`); }
    const lines = readFileSync(path, 'utf-8').split('\n');
    const start = claim.startLine ?? 1;
    const end = claim.endLine ?? claim.startLine ?? lines.length;
    if (start < 1 || end < start || start > lines.length) { return fail('fabricated', `line range ${start}-${end} is outside the file (${lines.length} lines)`); }
    if (end - start + 1 > MAX_CITED_LINES) { return fail('invalid', `cite at most ${MAX_CITED_LINES} lines; narrow the range to the evidence`); }
    const cited = lines.slice(start - 1, end).join('\n');
    if (claim.quote && !normalize(cited).includes(normalize(claim.quote))) {
        return fail('fabricated', normalize(lines.join('\n')).includes(normalize(claim.quote)) ? 'quote exists in the file but not in the cited range' : 'quote does not appear in the file');
    }
    return { lines, start, end, cited };
}

async function judgeRelation(client: JevClient, claim: Claim, { lines, start, end, cited }: Citation): Promise<ClaimVerdict> {
    // A little surrounding context keeps identifiers meaningful; the judgment is still about the cited lines.
    const context = lines.slice(Math.max(0, start - 1 - CONTEXT_LINES), Math.min(lines.length, end + CONTEXT_LINES)).join('\n');
    const answer = (await client.choose({ file: claim.file, cited_code: cited, surrounding_code: context, claim: claim.claim }, {
        relation: {
            type: 'choice',
            instructions: 'How does the source code in `cited_code` relate to the statement in `claim`? `surrounding_code` is only context for identifiers.',
            criteria: {
                supports: 'The cited code shows what the claim states, or directly implies it.',
                contradicts: 'The cited code shows the opposite of the claim: the thing said to be missing is present, or the thing said to happen does not.',
                says_nothing: 'The cited code does not address what the claim asserts; it is about something else, or the decisive part is not in these lines.',
            },
        },
    })).relation;
    if (!answer) { return { id: claim.id, verdict: 'review', confidence: 0, detail: 'no answer' }; }
    const probabilities = Object.entries(answer.probabilities).map(([option, p]) => `${option}=${p.toFixed(2)}`).join(' ');
    const top = answer.probabilities[answer.choice] ?? 0;
    if (top < AUTO_ACCEPT) { return { id: claim.id, verdict: 'review', confidence: top, detail: `uncertain (${probabilities}); re-read the code before relying on this claim` }; }
    const verdict = answer.choice === 'supports' ? 'verified' : answer.choice === 'contradicts' ? 'contradicted' : 'unsupported';
    return { id: claim.id, verdict, confidence: top, detail: probabilities };
}

export async function verifyClaims(client: JevClient, root: string, claims: readonly Claim[]): Promise<ClaimVerdict[]> {
    return await Promise.all(claims.map(async (claim) => {
        const checked = checkCitation(root, claim);
        return 'verdict' in checked ? checked : judgeRelation(client, claim, checked);
    }));
}
