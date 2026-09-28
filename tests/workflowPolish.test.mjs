import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPolishMessages, polishPrompt } from '../lib/gateway/workflowPolish.mjs';

const STYLE = {
    enabled: true, version: 2, defaultLook: 'pixar',
    looks: { pixar: { name: 'Pixar', brief: 'high-end stylized 3D animated feature-film quality', negatives: 'photorealism, cel shading' } },
    characters: { Maahi: 'powder-blue baby elephant', Champa: 'blue, distinctive eyelashes' },
};

test('polish messages carry the style brief, negatives, cast names and the user prompt', () => {
    const [system, user] = buildPolishMessages(STYLE, 'maahi plays in the river');
    assert.match(system.content, /feature-film quality/);
    assert.match(system.content, /NEVER: photorealism/);
    assert.match(system.content, /Maahi, Champa/);
    // The content contract: the model must not invent subjects.
    assert.match(system.content, /never add new characters/i);
    assert.equal(user.content, 'maahi plays in the river');
});

test('polish is best-effort: no key / no style / empty prompt → null, never a throw', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
        assert.equal(await polishPrompt({ style: STYLE, prompt: 'x' }), null);
        assert.equal(await polishPrompt({ style: null, prompt: 'x' }), null);
        assert.equal(await polishPrompt({ style: STYLE, prompt: '' }), null);
    } finally {
        if (saved != null) process.env.OPENAI_API_KEY = saved;
    }
});
