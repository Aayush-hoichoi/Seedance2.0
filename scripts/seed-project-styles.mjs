// Seed projects.style for the three shows that need generation consistency.
//
// The briefs below are not invented — each was distilled from that project's own
// approved history (the generations its team actually liked), so what gets
// injected is the look the team already signed off on:
//
//   MAHISHASUR MARDINI (33)  1,382 prompts, 267 liked (19.3% baseline). The team
//     ran three contradictory style bibles in three weeks; the brief below is
//     the current winner ("stylized painterly 3D game-simulation", 35% like
//     rate). The dead Era-1 block ("2.5D painterly … zero ink outline") scored
//     0 likes in 58 uses and is in the negatives so it cannot come back.
//   Maahi (28)               963 prompts. One style token spelled 8 ways, the
//     hero's colour 6 ways, and repeated emergency scale locks.
//   The Good Samaritan (13)  236 prompts, 16 likes — ALL in the car-chase
//     sequence, which has two approved sub-looks. Hence three looks and a
//     deliberate default; the yacht and maritime material must not get the
//     chase brief. Project 45 is the same show under a second project row.
//
// Usage:  node scripts/seed-project-styles.mjs [--apply] [--project <id>]
// Dry run by default — prints what it would write and changes nothing.

import { neon } from '@neondatabase/serverless';

const MAHISHASUR = {
    enabled: true,
    version: 1,
    defaultLook: 'painterly',
    looks: {
        painterly: {
            name: 'Stylized painterly 3D game-sim',
            brief: [
                'Stylized painterly 3D game-simulation render, AAA stylized game cinematic quality, painterly matte-finish skin shader, soft highlight rolloff, subtle painterly grain, soft vignette. Consistent stylized painterly look in every frame — stable identity, no morphing, no flicker.',
                'FORMAT: 16:9, 24fps, one continuous take, no cuts, no dissolve. Default to a locked-off static camera; when a move is specified, one smooth eased move only.',
                'IDENTITY: reference images are absolute. Lock faces, facial structure, skin tone, costume, jewellery, crowns and proportions to the references in every frame. Match the first-frame reference exactly at frame 0.',
                'LIGHT & PALETTE: cinematic cold-versus-warm — cool steel-blue and blue-white ambient worlds (blizzard, ice cave, night cosmic ocean) against warm saffron, maroon, rust and gold accents on characters. Golden-hour warmth for Kailash. Lighting constant through the shot.',
                'PERFORMANCE: subtle, restrained, devotional acting — natural irregular blinks, slow breathing, micro head movement. Hindi dialogue with accurate native lip-sync. Never theatrical.',
            ].join('\n'),
            negatives: 'photoreal drift, oily or glossy skin, visible pore maps, plastic or waxy shader, anime or 2D cel shading, ink outline, 2.5D painterly flat-plane animation, staccato motion, handheld shake, whip pans, speed ramps, face morphing, identity drift, text overlay.',
        },
    },
    // Injected only when the shot names the character. Wardrobe wording is
    // standardized here because the corpus drifted badly: Menaka's veil was
    // written eight different ways, Parvati's ornaments flipped lilac/purple.
    characters: {
        Himalaya: 'dignified 50-year-old king, weathered noble face, salt-and-pepper curled hair and beard, calm paternal gravity; tall gold crown, gold earrings, gold lion-face pendant necklace, bare chest, deep maroon velvet uttariya with gold-beige border over the left shoulder, cream dhoti with maroon border, gold armband and bracelets, gold bell anklets, barefoot.',
        Menaka: '35-year-old divine mother figure; gold filigree tiara, long dark hair, red bindi, sheer copper-rose veil with gold edge, pearl-drop earrings, choker, long chain with round pendant, armlets and bangles, dark brown velvet drape with gold wavy border, cream finely pleated saree, brown blouse, barefoot.',
        Parvati: 'warm golden-brown skin, large almond eyes with dark brown irises, small round red bindi, long dark brown wavy hair in a thick single braid over the left shoulder threaded with small gold-and-lilac flower ornaments, lilac floral gold jhumka earrings, deep maroon-wine saree with gold border, dusty pink fitted blouse.',
        Shiva: '34-year-old, blue skin with smooth texture, tripundra ash stripes, closed third eye, crescent moon, matted jata hair, rudraksha malas, coiled serpent Vasuki, tiger-skin garment, seated padmasana on the luminous aquamarine crystal throne, silver trishul planted beside him.',
        Vishnu: 'Padmanabha in yogic sleep on Shesha Naga in the cosmic night; a luminous green lotus stem emerges from his navel, glowing golden-green and pulsing gently like a slow heartbeat.',
        Brahma: '65-year-old, multi-headed, seated on the glowing pink lotus in the night sky above the cosmic ocean.',
        Mahishasura: 'imposing rakshasa king, a disturbing fusion of human and Indian water buffalo.',
    },
};

const MAAHI = {
    enabled: true,
    version: 1,
    defaultLook: 'pixar',
    looks: {
        pixar: {
            name: '3D Disney-Pixar animated realism',
            brief: [
                '3D Disney-Pixar Animated Realism: high-end stylized 3D animated feature-film quality, premium image quality, stable anatomy, clean textures, soft natural skin shading, believable weight and secondary motion in ears, trunk and tail, strong environmental depth, cinematic depth of field.',
                'FORMAT: 16:9, 24fps, real-time natural motion, exact stated duration. Multi-shot sequences use controlled HARD CUTS only; each angle stable and compositionally clean.',
                'IDENTITY: match the supplied character references 100% — never redesign. Follow the supplied size/proportion reference as an absolute scale lock. Maahi and Champa are exactly the same height and body size (1:1 world-space scale). In family shots Maahi is always clearly the smallest and the adults tower over the children.',
                'LIGHT & WORLD: flowering mountain meadow with rocks and distant peaks, misty bamboo forest and cliff path, or river-waterfall-sandpit. Default light is soft and diffused dreamy sunlight with gentle golden warmth, slight atmospheric haze and subtle floating pollen. Bamboo and danger scenes go dark green, humid, mist-layered with volumetric light shafts.',
                'PERFORMANCE: expressive but restrained feature-film acting; the children read young, restless and physical. Hindi dialogue with child voices.',
            ].join('\n'),
            negatives: 'plastic or waxy CG look, photorealism, 2D or cel shading, harsh sunlight, hard shadows, oversharp contrast, dissolves, morph transitions, background morphing, teleportation, hidden edits, subtitles, narration, music.',
        },
    },
    characters: {
        Maahi: 'hero, 3-year-old powder-blue baby elephant; large expressive upward-looking eyes, big rounded ears with pink inner ears, small ivory tusks, short head tuft, highly interactive trunk, innocent dream-filled energy.',
        Champa: '3-year-old female, blue, distinctive eyelashes, expressive eyes, broad ears, highly interactive trunk, confident and slightly sarcastic practical intelligence; exactly the same height and body size as Maahi.',
        Ila: 'mother; pale blue-grey female elephant, small tusks, pink inner ears, distinctive hair tuft, eyelashes, maternal emotional softness.',
        Varana: 'father, appears in dream and flashback only; periwinkle blue-grey wrinkled skin, huge rounded ears, long curved ivory tusks, wispy crown hair, heavy-lidded warm brown eyes, tufted tail.',
        Chenguttu: 'grandfather; huge, aged, calm, gentle and wise, very large tusks, massive body, dignified but slightly confused energy.',
        Trumpo: 'herd chief; large blue male elephant with one long intact tusk and one shortened broken tusk, commanding posture.',
        Keshi: 'villain; stylized 3D animated Bengal tiger, rich orange fur, bold dark stripes, white cheek and throat fur, strong predatory eyes, powerful jaw.',
    },
};

const GOOD_SAMARITAN = {
    enabled: true,
    version: 1,
    // The chase is where every approved output lives, so it is the default —
    // but the project also holds yacht and maritime material, which is exactly
    // why this is a look and not a single project-wide brief.
    defaultLook: 'chase',
    looks: {
        chase: {
            name: 'Indonesian street chase (clean)',
            brief: [
                'Photorealistic cinematic automotive-commercial look, natural bright midday daylight, 24fps, default 5-second take or the source plate\'s exact frame count.',
                'HERO VEHICLES (locked identity): a modified black Toyota Vellfire, plate VPR 6315 — sport bodykit, chrome lower grille, LED headlights ON with blue LED accent lights glowing at the lower grille, body slightly dusty with street reflections on the glass. Companion vehicle: a white Toyota Vellfire MPV. Never change model, colour, proportions, stance or plate.',
                'WORLD: a busy Jogja/Malioboro-style Indonesian market street — median with hedges, ornate lampposts, red-and-white flags and bunting; shophouses covered in overlapping Bahasa Indonesia signage; street-food carts, umbrellas, becak pedicabs, weaving motorbikes, dense pedestrians; tangled overhead power lines; hazy vanishing point. Background crowd and traffic stay alive and naturally moving for the full duration, softly blurred on both sides — the street never goes dead after the hero car exits.',
                'MOTION: when a reference video is attached it is the absolute source of truth — copy camera position, camera movement or lack of it, motion path, curve direction, speed and tire rotation frame by frame. Motion accuracy must be 100%. Realistic rolling motion with visible suspension bounce and subtle wheel motion blur.',
            ].join('\n'),
            negatives: 'AI-composited or pasted-on background feel, changes to locked layers (subject car, camera, framing, dark surround), tuk-tuks in place of becaks, lighting shifts away from bright tropical daylight, added pans, tilts, zooms or shake.',
        },
        'chase-window': {
            name: 'Indonesian street chase (window look)',
            brief: [
                'Photorealistic cinematic automotive-commercial look, natural bright midday daylight, 24fps, matching the source plate\'s exact frame count.',
                'SHOT SIGNATURE — PRESERVE EXACTLY: the frame reads as if shot from inside a vehicle through a port. Strong barrel lens distortion so straight lines bow outward, bending most at the edges. A heavy rounded vignette darkening and softening all four corners so the image reads as a circular port rather than a rectangle. Solid black letterbox bars across the top and bottom with NO content, light or glow generated inside them. The replaced background must be bent by the same lens as the car.',
                'HERO VEHICLE (locked identity): modified black Toyota Vellfire, plate VPR 6315, LED headlights on with blue accent lights at the lower grille.',
                'WORLD: busy Jogja/Malioboro-style Indonesian market street — hedged median, ornate lampposts, Bahasa Indonesia shopfront signage, becaks, motorbikes and pedestrians alive on both sides.',
                'MOTION: @Video 1 is the absolute source of truth for motion, framing, foreground action, camera movement, reflections and optical effects; the environment reference supplies only the new background.',
            ].join('\n'),
            negatives: 'any content, light or glow inside the black letterbox bars, AI-composited or pasted-on background feel, changes to locked layers, tuk-tuks in place of becaks, added camera moves.',
        },
        yacht: {
            name: 'Yacht dialogue',
            brief: [
                'Photorealistic cinematic look, golden-hour sunset light, shallow depth of field.',
                'SETTING: the rear sofa deck of a yacht — teak wood decking, cream and off-white cushions with grey throw pillows, open water behind.',
                'PERFORMANCE: naturalistic restrained dialogue acting. Preserve the original Bengali audio, voices and timbre exactly.',
            ].join('\n'),
            negatives: 'relighting away from golden hour, changes to wardrobe or face identity, added camera moves, dubbed or altered voices.',
        },
    },
    characters: {},
};

const SEEDS = [
    { id: 33, name: 'MAHISHASUR MARDINI', style: MAHISHASUR },
    { id: 28, name: 'Mahi', style: MAAHI },
    { id: 13, name: 'The Good Samaritan', style: GOOD_SAMARITAN },
    // Same show, second project row. It has zero liked outputs of its own and
    // its divergent template measurably underperformed the parent's, so it
    // inherits the parent's config rather than keeping its own drift.
    { id: 45, name: 'The Good Samaritan jini', style: GOOD_SAMARITAN },
];

// Workspace workflows: the same three styles, attachable by any user from the
// studio's Workflows picker regardless of project. Keyed by name for idempotent
// re-runs.
// sourceProjects: the show's own project rows. The nightly refresh
// (workflowRefresh.mjs) learns from liked generations stamped with the
// workflow AND from these projects, so the loop has signal from day one.
const WORKFLOWS = [
    { name: 'Mahi Style', description: '3D Disney-Pixar animated realism — the Maahi elephant family look.', style: { ...MAAHI, sourceProjects: [28] } },
    { name: 'Mahishasur Mardini Style', description: 'Stylized painterly 3D game-sim — the approved Mahishasur Mardini look.', style: { ...MAHISHASUR, sourceProjects: [33] } },
    { name: 'The Good Samaritan Style', description: 'Photoreal Indonesian street chase, window and yacht looks.', style: { ...GOOD_SAMARITAN, sourceProjects: [13, 45] } },
];

async function main() {
    const apply = process.argv.includes('--apply');
    const only = process.argv.includes('--project')
        ? Number(process.argv[process.argv.indexOf('--project') + 1])
        : null;
    const url = process.env.DATABASE_URL;
    if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
    const sql = neon(url);

    const targets = only ? SEEDS.filter((s) => s.id === only) : SEEDS;
    if (!targets.length) { console.error(`No seed defined for project ${only}.`); process.exit(1); }

    for (const seed of targets) {
        const [project] = await sql`SELECT id, name, style FROM projects WHERE id = ${seed.id}`;
        if (!project) { console.error(`  ! project ${seed.id} (${seed.name}) not found — skipped`); continue; }
        // The id is the key, not the name; warn rather than guess if they differ.
        if (project.name !== seed.name) {
            console.warn(`  ! project ${seed.id} is named "${project.name}", expected "${seed.name}"`);
        }
        const looks = Object.keys(seed.style.looks).join(', ');
        const chars = Object.keys(seed.style.characters).length;
        const bytes = JSON.stringify(seed.style).length;
        const had = project.style ? `v${project.style.version} present` : 'none';
        console.log(`${apply ? 'WRITE' : 'DRY  '} ${seed.id} ${project.name}`);
        console.log(`        existing: ${had} → v${seed.style.version}, looks: [${looks}], default: ${seed.style.defaultLook}, characters: ${chars}, ${bytes} bytes`);

        if (!apply) continue;
        // Bump past whatever is already stored so version stays monotonic per
        // project — the evaluation views group like-rate by it.
        const version = Math.max(seed.style.version, (project.style?.version ?? 0) + 1);
        await sql`UPDATE projects SET style = ${JSON.stringify({ ...seed.style, version })}::jsonb WHERE id = ${seed.id}`;
        console.log(`        written as v${version}`);
    }

    // Workspace workflows (skipped when --project narrows the run). The table
    // is created by the schema chain on the first deploy after v21 — until
    // then, report and move on rather than crash the project half of the run.
    if (!only) {
        const [table] = await sql`SELECT to_regclass('workflows') AS t`;
        if (!table?.t) {
            console.log('  ! workflows table does not exist yet — deploy first (schema v21 creates it), then re-run');
            if (!apply) console.log('\nDry run. Re-run with --apply to write. This turns the style layer ON for these projects.');
            return;
        }
        for (const wf of WORKFLOWS) {
            const [existing] = await sql`SELECT id, style FROM workflows WHERE name = ${wf.name} AND deleted_at IS NULL`;
            const had = existing ? `v${existing.style?.version ?? '?'} present` : 'none';
            // The nightly refresh (workflowRefresh.mjs) evolves these styles
            // past v1. Re-running the seed must never stomp what the workflow
            // has learned with this file's older text.
            if ((existing?.style?.version ?? 0) > wf.style.version) {
                console.log(`SKIP  workflow "${wf.name}" (${had} — newer than this seed, kept)`);
                continue;
            }
            console.log(`${apply ? 'WRITE' : 'DRY  '} workflow "${wf.name}" (existing: ${had})`);
            if (!apply) continue;
            const version = Math.max(wf.style.version, (existing?.style?.version ?? 0) + 1);
            const style = JSON.stringify({ ...wf.style, version });
            if (existing) {
                await sql`UPDATE workflows SET style = ${style}::jsonb, description = ${wf.description} WHERE id = ${existing.id}`;
            } else {
                await sql`INSERT INTO workflows (name, description, style) VALUES (${wf.name}, ${wf.description}, ${style}::jsonb)`;
            }
        }
    }

    if (!apply) console.log('\nDry run. Re-run with --apply to write. This turns the style layer ON for these projects.');
}

main().catch((error) => { console.error(error); process.exit(1); });
