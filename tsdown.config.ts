import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        mutate: 'src/mutate.ts',
        prepare: 'src/prepare.ts',
        bin: 'bin/jevlint.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node20',
    fixedExtension: true,
    dts: true,
    sourcemap: false,
    clean: true,
});
