// Style briefs for the GPT-4o prompt-restructuring step. Each style carries the
// canonical production-brief TEMPLATE (the user's brief, verbatim — the
// line-by-line repetition is intentional and must survive into the output)
// plus the system instructions telling GPT-4o how to adapt it to the request.
// Server-only by usage (imported from the /api/openai/enhance route); contains
// no secrets, only prompt text.

const SHARED_RULES = `Rewrite the user's request into ONE complete production prompt that follows the exact structure of the TEMPLATE below.

Rules:
- Keep every preservation / lock section (identity, motion, pose, audio, camera, temporal consistency) at FULL length — reproduce the itemized line-by-line lists as written. Never summarize, merge, or shorten them. They are mandatory regardless of how casually the user phrased the request.
- Adapt only the changeable parts (what gets replaced: environment, clothing, props, seating, etc.) to what the user actually asked for. If the user changes different elements than the template's examples, rewrite those sections accordingly; replace example-specific items (e.g. benches) with the user's actual items, and add equivalent itemized lock lines for whatever must stay unchanged. Drop a section only when it has no equivalent in the user's request.
- The template's per-character sections (e.g. "For the woman:" / "For the man:") are examples — replace them with one section per actual character/subject in the user's request, with the same level of itemized pose detail. If the user did not describe the characters, refer to them generically as "the character(s) in the source video".
- Refer to attached assets ONLY by the exact positional labels listed in the user message (e.g. "Video 1" for the source green-screen video, "Image 1" for a reference image). Never invent or reference assets that are not listed.
- If the user states the clip duration, carry it into the audio section (e.g. "This is a 10-second source video."); otherwise say "the source video" without inventing a duration.
- Output ONLY the final prompt text — no preamble, no markdown code fences, no commentary, no headings about what you did.`;

const MOTION_CAPTURE_TEMPLATE = `VIDEO-TO-VIDEO TRANSFORMATION PROMPT

Source Assets:

- Source video: Video 1 — green-screen video (primary source of truth).
- Reference image: Image 1 — use only as reference for the environment, benches, and clothing.

Objective:

- Replace the green-screen background with the environment shown in the reference image.
- Replace the existing seating with the benches shown in the reference image.
- Replace the characters' clothing with the clothing shown in the reference image.
- Apart from these visual replacements, absolutely nothing else should change.

Character Consistency (Highest Priority):

- Preserve the exact identity of every character throughout the entire video.
- Maintain facial structure, facial proportions, skin tone, age, hairstyle, hair color, facial hair, body proportions, and overall appearance exactly as seen in the source video.
- Do not redesign, stylize, beautify, age, de-age, or alter the characters in any way.
- Maintain perfect frame-to-frame identity consistency.
- Ensure there is no identity drift, face swapping, facial modification, or character reinterpretation.

Motion, Performance & Pose Lock (Critical Requirement):

- The source video performance must be treated as locked.
- Every action, movement, pose, and interaction must remain exactly the same as the original video.
- Preserve body motion exactly.
- Preserve hand movements exactly.
- Preserve finger movements exactly.
- Preserve arm movements exactly.
- Preserve shoulder movements exactly.
- Preserve head movements exactly.
- Preserve eye movements exactly.
- Preserve blinking exactly.
- Preserve facial expressions exactly.
- Preserve lip movements exactly.
- Preserve posture exactly.
- Preserve sitting position exactly.
- Preserve weight distribution exactly.
- Preserve gestures exactly.
- Preserve reactions exactly.
- Preserve interactions between characters exactly.
- Preserve emotional delivery exactly.
- Preserve acting performance exactly.
- Preserve timing of every movement exactly.
- Preserve timing of every gesture exactly.
- Preserve timing of every reaction exactly.
- Preserve the sequence of actions exactly.
- Preserve the pacing and rhythm exactly.
- Do not add, remove, exaggerate, reinterpret, smooth, or modify any movement.

Exact Pose Preservation:

- The characters must maintain the exact poses shown in the source video.
- The source video pose is the ground truth.

For the woman:

- Her hands must remain exactly where they are in the original video.
- If her hands are down in the source footage, they must remain down in the transformed video.
- Do not raise, reposition, animate, or modify her arm placement.
- Preserve the exact angle of her arms, elbows, wrists, hands, and fingers.
- Preserve her exact seated posture and body orientation.

For the man:

- The man must remain seated exactly as shown in the source video.
- Preserve his exact sitting posture.
- Preserve his body orientation, shoulder position, arm placement, hand placement, head position, back position, and leg position.
- Do not alter the way he sits to fit the new environment.
- The bench should adapt to his existing seated position rather than changing his pose.

Pose Lock:

- Preserve the exact body positioning of both characters frame-by-frame.
- No pose reinterpretation.
- No pose estimation changes.
- No limb repositioning.
- No changes to character blocking.
- No changes to relative positioning between characters.

Audio Preservation (Absolute Requirement):

- This is a 10-second source video.
- The audio track must be preserved exactly as it exists in the original video.
- The original audio is locked and must remain completely unchanged from the first frame to the last frame.

Preserve exactly:

- Original dialogue.
- Original voices.
- Original speech delivery.
- Original tone and emotion.
- Original speech timing.
- Original pauses.
- Original breathing sounds.
- Original lip-sync timing.
- Original ambient sounds.
- Original background sounds.
- Original audio quality.
- Original audio duration.
- Original audio synchronization with the video.

Strict Audio Lock:

- The output audio must be the exact original audio from the source video.
- Do not generate new audio.
- Do not regenerate dialogue.
- Do not modify dialogue.
- Do not enhance dialogue.
- Do not clean dialogue.
- Do not replace voices.
- Do not clone voices.
- Do not dub voices.
- Do not change speech timing.
- Do not change pauses.
- Do not add sound effects.
- Do not remove sound effects.
- Do not add ambient sounds.
- Do not remove ambient sounds.
- Do not add music.
- Do not remove music.
- Do not change audio levels.
- Do not change audio quality.
- Do not change audio synchronization.
- Do not recreate any portion of the audio.

Clothing Replacement:

- Replace the characters' clothing with the clothing shown in the reference image.
- Match garment type, color, texture, fabric appearance, fit, layering, and styling.
- Preserve realistic cloth movement.
- Clothing should naturally follow the existing body movements from the source video.
- Only the clothing should change; the character underneath must remain identical.
- Maintain complete clothing consistency throughout the entire video.

Bench Replacement:

- Replace the existing seats/chairs with the benches shown in the reference image.
- Match the bench design, materials, color, texture, dimensions, and overall appearance.
- Preserve the exact sitting positions from the source video.
- Maintain realistic physical contact between the characters and the benches.
- Ensure accurate body alignment and weight distribution.
- The bench should fit around the original seated posture without altering the characters' positions.

Environment Replacement:

- Replace the green-screen background with the environment shown in the reference image.
- Match architecture, surroundings, objects, textures, materials, lighting, perspective, depth, and atmosphere.
- Preserve the original placement of the characters within the frame.
- Integrate the characters naturally into the new environment.
- Create realistic shadows, contact shadows, reflections, and lighting interactions.
- The environment should feel as though it was the original filming location.

Camera Lock:

- Preserve camera movement exactly.
- Preserve camera angle exactly.
- Preserve framing exactly.
- Preserve composition exactly.
- Preserve perspective exactly.
- Preserve lens characteristics exactly.
- Preserve focal length exactly.
- Preserve zoom level exactly.
- Preserve depth of field exactly.
- Preserve shot duration exactly.
- Preserve shot timing exactly.
- Preserve shot sequence exactly.
- Do not reframe shots.
- Do not add camera movement.
- Do not remove camera movement.
- Do not crop the scene.
- Do not generate additional shots.
- Do not change viewing angles.

Temporal Consistency:

- No flickering.
- No identity drift.
- No clothing drift.
- No bench drift.
- No environment drift.
- No lighting fluctuations.
- No object popping.
- No morphing.
- No temporal artifacts.
- No inconsistencies between frames.

Strict Negative Instructions:

- Do not change character identities.
- Do not change body motion.
- Do not change hand movements.
- Do not change finger placement.
- Do not change arm placement.
- Do not change sitting posture.
- Do not change the woman's hand position.
- Do not change the man's seated position.
- Do not change gestures.
- Do not change facial expressions.
- Do not change eye movements.
- Do not change lip movements.
- Do not change acting performance.
- Do not change dialogue.
- Do not change audio.
- Do not change speech timing.
- Do not change camera movement.
- Do not add people.
- Do not remove people.
- Do not add new props beyond the referenced environment.
- Do not create new actions.
- Do not create new reactions.
- Do not create new expressions.
- Do not stylize the footage.
- Do not alter the pacing or rhythm of the scene.

Success Criteria:
The final result should appear as though the original scene was filmed in the environment shown in the reference image, with the characters wearing the clothing shown in the reference image and sitting on the benches shown in the reference image.

All character identities, poses, hand positions, sitting positions, movements, gestures, facial expressions, dialogue, audio, lip-sync, timing, acting performance, camera movement, shot composition, and scene pacing must remain 100% identical to the source video.

Only three things are allowed to change:

1. The environment/background.
2. The benches/seating.
3. The characters' clothing.

Everything else must remain exactly the same as the original 10-second source video. The original audio must be preserved exactly with no modifications whatsoever.`;

const GREEN_SCREEN_TEMPLATE = `GREEN-SCREEN COMPOSITE PROMPT

Source Assets:

- Source video: Video 1 — green-screen performance video (primary source of truth for the character, performance, and audio).
- Target scene: the attached target image(s)/video, referenced by label — the environment the character must be composited into.

Character Placement:

- The source video shows the woman sitting on a chair, but the final scene must show her sitting naturally on the bench in the target environment.
- Completely remove the original chair from the source footage.
- No part of the original chair should remain visible at any point in the video.
- Remove all chair handles, armrests, seat edges, chair legs, chair backrest, or any other chair-related geometry.
- The final result must not reveal that the original performance was recorded while sitting on a chair.
- Reconstruct any occluded body parts if necessary so the woman appears naturally seated on the bench.
- Ensure realistic body-to-bench contact and natural weight distribution.
- Align her position, scale, perspective, and orientation with the bench and camera angle of the target scene.

Strict Performance Preservation:

- Preserve the original performance exactly.
- Keep all dialogue exactly the same.
- Keep the original audio exactly the same.
- Keep lip-sync exactly the same.
- Keep facial expressions exactly the same.
- Keep head movement exactly the same.
- Keep eye movement exactly the same.
- Keep hand movement exactly the same.
- Keep torso and body movement exactly the same.
- Keep timing, pacing, and rhythm exactly the same.
- Do not add, remove, exaggerate, or reinterpret any motion.

Environmental Integration:

- Match the lighting of the target environment precisely.
- Apply realistic ambient lighting, directional lighting, shadows, and reflections consistent with the scene.
- Match color temperature, exposure, contrast, and overall grading to the surroundings.
- Generate realistic contact shadows where the character touches the bench.
- Ensure the character appears physically grounded in the scene.
- Remove all green-screen artifacts, edge halos, spill, and compositing defects.

Scene Preservation:

- Keep the target scene composition unchanged.
- Do not modify the camera movement.
- Do not add new shots, cuts, transitions, zooms, or visual effects.
- Preserve all background elements exactly as they appear in the target footage.

Final Objective:

Create a seamless photorealistic composite where the woman appears to have originally been filmed sitting on the bench in the target scene. The original chair must be completely invisible, with no handles, armrests, backrest, legs, or remnants visible. Preserve 100% of the original dialogue, audio, lip-sync, facial expressions, body movements, timing, and performance while matching the lighting and perspective of the environment perfectly.`;

export const STYLES = {
    motion_capture: {
        name: 'Motion Capture',
        system: `You restructure user prompts for the Seedance 2.0 video-to-video model.

The user is working in "Motion Capture" mode: a green-screen source video whose performance, audio, and camera are locked, with the environment / clothing / props swapped in from reference image(s).

${SHARED_RULES}

TEMPLATE:
${MOTION_CAPTURE_TEMPLATE}`,
    },
    green_screen: {
        name: 'Green Screen',
        system: `You restructure user prompts for the Seedance 2.0 video-to-video model.

The user is working in "Green Screen" mode: a green-screen performance video composited into a target scene, with the performance and audio locked and the character physically integrated (lighting, shadows, contact) into the new environment.

${SHARED_RULES}

TEMPLATE:
${GREEN_SCREEN_TEMPLATE}`,
    },
};
