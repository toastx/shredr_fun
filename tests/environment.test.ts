/**
 * Tests for the dev/prod environment switch.
 *
 * `constants.ts` resolves its values once at module load, so each case reloads
 * the module with a different `process.env` rather than mutating it in place.
 */

import './setup';
import { expect } from 'chai';

const VARS = [
    'KORA_RELAYER_URL',
    'KORA_ROLLUP_RELAYER_URL',
    'KORA_RELAYER_PUBKEY',
    'HELIUS_RPC_URL',
    'HELIUS_WSS_URL',
    'MAGICBLOCK_RPC_URL',
    'MAGICBLOCK_WSS_URL',
    'API_BASE_URL',
] as const;

/** Load a fresh copy of constants.ts under the given environment. */
async function loadConstants(vars: Record<string, string>) {
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('VITE_')) delete process.env[key];
    }
    Object.assign(process.env, vars);

    // Cache-bust so the module re-evaluates against the new env.
    const module = await import(`../src/lib/constants.ts?case=${Math.random()}`);

    process.env = saved;
    return module;
}

describe('environment switch', () => {
    it('uses the plain VITE_* values when unset', async () => {
        const c = await loadConstants({
            VITE_API_BASE_URL: 'https://prod.example',
            VITE_DEV_API_BASE_URL: 'http://localhost:8000',
        });
        expect(c.ENVIRONMENT).to.equal('prod');
        expect(c.IS_DEV_ENVIRONMENT).to.equal(false);
        expect(c.API_BASE_URL).to.equal('https://prod.example');
    });

    it('defaults to prod for an unrecognised value', async () => {
        // A typo must not hand a deployed build the developer endpoints.
        const c = await loadConstants({
            VITE_ENVIRONMENT: 'devv',
            VITE_API_BASE_URL: 'https://prod.example',
            VITE_DEV_API_BASE_URL: 'http://localhost:8000',
        });
        expect(c.ENVIRONMENT).to.equal('prod');
        expect(c.API_BASE_URL).to.equal('https://prod.example');
    });

    it('prefers the VITE_DEV_* twin when dev is selected', async () => {
        const c = await loadConstants({
            VITE_ENVIRONMENT: 'dev',
            VITE_API_BASE_URL: 'https://prod.example',
            VITE_DEV_API_BASE_URL: 'http://localhost:8000',
        });
        expect(c.ENVIRONMENT).to.equal('dev');
        expect(c.IS_DEV_ENVIRONMENT).to.equal(true);
        expect(c.API_BASE_URL).to.equal('http://localhost:8000');
    });

    it('is case-insensitive on the selector', async () => {
        const c = await loadConstants({
            VITE_ENVIRONMENT: 'DEV',
            VITE_DEV_API_BASE_URL: 'http://localhost:8000',
        });
        expect(c.ENVIRONMENT).to.equal('dev');
    });

    it('falls back to the plain value when a dev twin is missing', async () => {
        const c = await loadConstants({
            VITE_ENVIRONMENT: 'dev',
            VITE_API_BASE_URL: 'https://prod.example',
        });
        // Deliberate: a partial dev config still works. The warning is what
        // makes the fallback visible.
        expect(c.API_BASE_URL).to.equal('https://prod.example');
    });

    it('switches every variable, not just the ones in use', async () => {
        const prod = Object.fromEntries(
            VARS.map((v) => [`VITE_${v}`, `prod-${v}`]),
        );
        const dev = Object.fromEntries(
            VARS.map((v) => [`VITE_DEV_${v}`, `dev-${v}`]),
        );

        const c = await loadConstants({ VITE_ENVIRONMENT: 'dev', ...prod, ...dev });

        for (const v of VARS) {
            expect(c[v], v).to.equal(`dev-${v}`);
        }
    });
});
