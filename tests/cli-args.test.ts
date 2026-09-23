import { describe, expect, it } from 'vitest';
import { helpText, hookFilePath, parseArgs, UsageError } from '../src/cli.js';

describe('parseArgs', () => {
    it('defaults to scan and keeps every token as scan input', () => {
        const args = parseArgs(['src', '--owned', '--rules=a,b/']);
        expect(args.command).toBe('scan');
        expect(args.positionals).toEqual(['src']);
        expect(args.flags.has('owned')).toBe(true);
        expect(args.values.get('rules')).toBe('a,b/');
    });

    it('takes an option value as "--name=value" or "--name value", keeping any "=" after the first', () => {
        expect(parseArgs(['--base', 'origin/main']).values.get('base')).toBe('origin/main');
        expect(parseArgs(['--base=feature/x=y']).values.get('base')).toBe('feature/x=y');
        expect(parseArgs(['test', '--config', 'cfg/jevlint.config.ts']).values.get('config')).toBe('cfg/jevlint.config.ts');
    });

    it('recognizes a command only in first position', () => {
        expect(parseArgs(['test', '--record']).command).toBe('test');
        expect(parseArgs(['src/test']).command).toBe('scan');
        expect(parseArgs(['cache', 'prune', '--max-age-days=7'])).toMatchObject({ command: 'cache', positionals: ['prune'] });
    });

    it('rejects unknown options, options of another command, and missing or unexpected values', () => {
        expect(() => parseArgs(['--nope'])).toThrow(UsageError);
        expect(() => parseArgs(['test', '--format=json'])).toThrow(/unknown option '--format=json'/);
        expect(() => parseArgs(['--rules'])).toThrow(/needs a value/);
        expect(() => parseArgs(['--rules', '--owned'])).toThrow(/needs a value/);
        expect(() => parseArgs(['--owned=yes'])).toThrow(/does not take a value/);
        try {
            parseArgs(['recall', '--bogus']);
        } catch (err) {
            expect((err as UsageError).command).toBe('recall');
        }
    });

    it('treats -h and --help as help for the selected command', () => {
        expect(parseArgs(['test', '-h']).flags.has('help')).toBe(true);
        expect(parseArgs(['--help']).command).toBe('scan');
    });
});

describe('helpText', () => {
    it('lists every command in the overview and each command\'s own options', () => {
        const overview = helpText('scan');
        for (const command of ['test', 'recall', 'baseline', 'list', 'verify', 'cache prune', 'hook', 'init']) { expect(overview).toContain(`  ${command}`); }
        expect(overview).toContain('Exit codes');
        expect(helpText('test')).toContain('--record');
        expect(helpText('recall')).toContain('--sample <n>');
        expect(helpText('hook')).toContain('stdin');
    });

    it('documents --no-locate and --no-prefilter, and no longer offers --new-only', () => {
        const scan = helpText('scan');
        expect(scan).toContain('--no-locate');
        expect(scan).toContain('--no-prefilter');
        expect(scan).not.toContain('--new-only');
        expect(parseArgs(['src', '--no-locate', '--no-prefilter']).flags.has('no-locate')).toBe(true);
    });
});

describe('hookFilePath', () => {
    it('finds the edited file in the payload shapes coding agents and editors send', () => {
        expect(hookFilePath({ file_path: 'src/a.ts' })).toBe('src/a.ts');
        expect(hookFilePath({ path: 'src/a.ts' })).toBe('src/a.ts');
        expect(hookFilePath({ tool_input: { file_path: '/abs/src/a.ts' } })).toBe('/abs/src/a.ts');
        expect(hookFilePath({ input: { file: 'src/a.ts' } })).toBe('src/a.ts');
    });

    it('returns undefined when there is no path', () => {
        expect(hookFilePath({})).toBeUndefined();
        expect(hookFilePath(null)).toBeUndefined();
        expect(hookFilePath({ tool_input: { command: 'ls' } })).toBeUndefined();
    });
});
