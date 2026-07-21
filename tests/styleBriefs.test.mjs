import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLES } from '../lib/openai/styleBriefs.js';

// The two enhancer failures these guard against, both seen in Motion Capture:
// (1) the brief inherited the template's asset roles instead of the user's, and
// (2) it requested a new action ("bubbles come out of his nose") while a
// negative line forbade new actions in the same prompt.

const motion = STYLES.motion_capture.system;

test('asset roles are taken from the user, not the template examples', () => {
    assert.match(motion, /ASSET ROLES COME FROM THE USER/);
    assert.match(motion, /never leave an attached asset without a stated purpose/);
    // The old hardcoded roles must not survive as fixed assignments.
    assert.doesNotMatch(motion, /use only as reference for the environment, benches, and clothing/);
});

test('requested actions outrank the locks, and every lock exempts them', () => {
    assert.match(motion, /REQUESTED ACTIONS OUTRANK THE LOCKS/);
    assert.match(motion, /Requested Actions & Effects \(Priority\):/);

    // No unqualified "do not create new actions" line may remain — that is the
    // exact contradiction that made the model drop user-requested gestures.
    for (const line of motion.split('\n')) {
        if (/^- Do not create new (actions|reactions|expressions)/.test(line)) {
            assert.match(line, /explicitly requested/, `unqualified negative: ${line}`);
        }
    }
});

test('the camera move is described and transferred, never only forbidden', () => {
    assert.match(motion, /THE CAMERA MOVE MUST BE DESCRIBED, NOT JUST FORBIDDEN/);
    assert.match(motion, /reproduce its move beat for beat/);
    // A bare "Do not add camera movement." leaves the model with nothing to
    // reproduce and reads as "hold the camera still".
    assert.doesNotMatch(motion, /\n- Do not add camera movement\.\n/);
    assert.match(motion, /Do not flatten, dampen, stabilise, smooth, slow, shorten, or drop any camera movement that IS in the source video/);
});

test('green screen shares the same rules', () => {
    assert.match(STYLES.green_screen.system, /REQUESTED ACTIONS OUTRANK THE LOCKS/);
    assert.match(STYLES.green_screen.system, /ASSET ROLES COME FROM THE USER/);
});
