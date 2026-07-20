// Splash copy for the projects hub: the greeting pool, the joke pool, and the
// no-repeat cycle both run through.
//
// The old splash picked with a memoryless Math.random(), so the same line came
// up two reloads apart often enough to feel broken. Now every line shown —
// local OR fetched from icanhazdadjoke — is remembered in localStorage, and a
// joke can only come round again once the whole pool has been used.

export const HELLOS = [
    'Look who’s back — {name}!',
    'Ah, {name}. The render farm missed you.',
    '{name} has entered the studio 🎬',
    'Rolling out the red carpet for {name}…',
    'Quiet on set — {name} is here.',
    'Action! {name} is on the clock.',
    'Places, everyone. {name} just walked in.',
    'The GPUs just sat up straight. Hello, {name}.',
    '{name}! We kept your seat warm.',
    'Lights, camera, {name}.',
    'Somebody get {name} a coffee ☕',
    'And in tonight’s leading role: {name}.',
    'Welcome back, {name}. The queue is empty and hopeful.',
    '{name} is here — cue the dramatic music.',
    'Take one. Or take forty. Hi, {name}.',
    'The studio hums to life. Morning, {name}.',
    'Scene one, {name}, action.',
    '{name} returns. The render gods are pleased.',
];

export const JOKES = [
    'Why don’t film crews play hide and seek? Good luck hiding from the director’s cut.',
    'I told my video to be more positive. Now it only renders in HDR.',
    'The AI asked for a day off — said it was feeling a bit overexposed.',
    'I asked the model for a photorealistic horse. It gave me six legs and a lot of confidence.',
    'My render finished in four seconds. I’ve been staring at it for forty minutes looking for the catch.',
    'Why did the prompt go to therapy? Too many unresolved negatives.',
    'The GPU and I have an understanding: it melts, I panic.',
    'I tried to generate a video of silence. The model added a saxophone.',
    'Every AI video has exactly one hand too many. It’s the law.',
    'My prompt said “subtle”. The model heard “explosions”.',
    'Why did the storyboard break up with the script? It wanted to see other angles.',
    'I asked for 4K and my wallet asked for a lawyer.',
    'The render queue is just a waiting room with better lighting.',
    'Why don’t cameras ever get lost? They always know their focus.',
    'My first draft was terrible. My second draft was terrible in 1080p.',
    'The sunset it generated was gorgeous. The sun had two shadows. Nobody’s perfect.',
    'I told the model “cinematic”. It added lens flares to a spreadsheet.',
    'Deadline: a word the progress bar has never once heard.',
    'Why was the video file so calm? It had excellent compression.',
    'I asked for a dog on a skateboard. I got a skateboard on a dog. Technically correct.',
    'My model has great range: confused, very confused, and deeply confused.',
    'Why did the frame rate go to school? To get a little smoother.',
    'I generated a coffee cup. The steam is going downward. Physics is a suggestion now.',
    'Nothing ages a person like a progress bar sitting at 99%.',
    'The AI wrote my script. Every character is named “person walking”.',
    'Why don’t prompts ever win arguments? They keep getting overridden.',
    'I asked for “a quiet room”. It gave me a room, and the room looked nervous.',
    'My video has a plot twist: it finished rendering.',
    'Why did the pixel go to the party? It heard there would be resolution.',
    'I told the model to keep it short. It made a four-second existential crisis.',
    'The best special effect is a render that doesn’t crash.',
    'I asked for a realistic crowd. Everyone in the back row is the same guy.',
    'Why was the timeline so stressed? Too many cuts.',
    'My AI video is 90% breathtaking and 10% teeth. Always the teeth.',
    'I generated a chef. He’s holding the knife wrong and I respect his confidence.',
    'Nothing says “professional” like re-rendering the same clip nine times.',
    'I asked for golden hour. The sun is behind the camera AND in front of it.',
    'Why don’t AI models keep secrets? Everything ends up in the training set.',
    'My prompt was 400 words. The model read three of them.',
    'I generated a bicycle. One and a half wheels, enormous ambition.',
    'I told the model “no text in the image”. It wrote “no text” in the image.',
    'The scariest sound in filmmaking is a fan spinning up.',
    'I asked for a calm ocean. Got a calm ocean and one very concerned seagull.',
    'Why did the aspect ratio join the gym? It wanted to get wider.',
    'My best work happens roughly four seconds before the render crashes.',
    'I generated a car chase. The cars are chasing, just not each other.',
    'Why don’t editors ever finish? There’s always one more frame.',
    'I asked for “minimal”. It gave me an empty room and billed me for it.',
    'My model dreams at 24 frames per second. I dream about the GPU invoice.',
    'Why did the clip get promoted? Outstanding transitions.',
    'I generated a wedding. Everyone is delighted and nobody has a nose.',
    'The render finished early. I remain deeply suspicious.',
    'I asked for a violinist. She’s playing it like a guitar and she is committed.',
    'Why was the keyframe such a big deal? It held the whole thing together.',
    'I told it to be photorealistic. It just made everything shiny instead.',
    'My storyboard is twelve stick figures and a great deal of hope.',
    'Why don’t videos ever get cold? They’re always buffering.',
    'I generated a library. Every single book is titled “Bmoko”.',
    'The model gave me exactly what I asked for. That was my mistake.',
    'Why did the scene get reshot? The lighting had opinions.',
    'I asked for a peaceful forest. Got one, plus a deeply thoughtful deer.',
    'Two renders walk into a queue. Only one comes out.',
    'I upgraded to 4K so I could see my mistakes in greater detail.',
    'Why did the video apply for a loan? It ran out of credits.',
    'My negative prompt is just the word “no” repeated until I feel safe.',
    'I generated a guitarist with eleven fingers. He shreds, though.',
    'Why are AI hands so hard? Because the model has never had to hold anything.',
    'The seed was random. The disappointment was reproducible.',
    'I asked for “handheld camera”. It gave me a camera. Being held. By a hand.',
    'Why don’t drones ever get invited out? They hover too long.',
    'My favourite genre is “almost”.',
    'I asked for slow motion. Everything is now slow, including me.',
    'The model generated a mirror. The reflection is doing its own thing.',
    'Why did the codec get an award? Outstanding performance under pressure.',
    'I told it “documentary style”. It added a man with a clipboard to every shot.',
    'Rendering: the art of waiting expensively.',
    'I asked for one cat. There are now four cats and I love all of them.',
    'Why was the shot so confident? It nailed the composition on the first take.',
    'I generated a staircase. It goes up and also, somehow, up.',
    'My prompt engineering degree is just typing “cinematic, 8k, masterpiece” and hoping.',
    'Why don’t skeletons ever direct films? They don’t have the guts for notes.',
    'I only know 25 letters of the alphabet. I don’t know y.',
    'I used to hate facial hair, but then it grew on me.',
    'What do you call a fake noodle? An impasta.',
    'I would tell you a construction joke, but I’m still working on it.',
    'Why did the scarecrow win an award? He was outstanding in his field.',
];

const CAP = 300; // remembered lines; keeps localStorage from growing forever

// Pure core: choose something the reader hasn't seen this cycle. Returns the
// pick plus the updated seen-list. When the pool is exhausted the cycle resets,
// so the ONLY way a joke repeats is after every other one has been shown.
export function pickFresh(pool, seen = [], rand = Math.random) {
    const list = (Array.isArray(pool) ? pool : []).filter(Boolean);
    if (!list.length) return { pick: null, seen: Array.isArray(seen) ? seen : [] };
    const seenSet = new Set(Array.isArray(seen) ? seen : []);
    const unseen = list.filter((item) => !seenSet.has(item));
    const exhausted = unseen.length === 0;
    const from = exhausted ? list : unseen;
    // rand() is [0,1) for Math.random, but clamp so an injected rand can't
    // index past the end.
    const pick = from[Math.min(Math.floor(rand() * from.length), from.length - 1)];
    const next = exhausted ? [pick] : [...seenSet, pick];
    return { pick, seen: next.slice(-CAP) };
}

const keyFor = (name) => `splash:seen:${name}`;

export function readSeen(name) {
    try {
        const raw = globalThis.localStorage?.getItem(keyFor(name));
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
    } catch {
        return []; // private mode, quota, corrupt value — a repeat beats a crash
    }
}

export function writeSeen(name, seen) {
    try {
        globalThis.localStorage?.setItem(keyFor(name), JSON.stringify(seen.slice(-CAP)));
    } catch { /* storage unavailable — the splash still works, it just forgets */ }
}

// Pull the next unseen line from a pool and remember it.
export function nextFrom(pool, name) {
    const { pick, seen } = pickFresh(pool, readSeen(name));
    if (pick) writeSeen(name, seen);
    return pick;
}

// A joke fetched from the API counts against the same history, so the remote
// source can't hand back one we've already told. Returns null when it's a
// repeat (or empty) and the caller should fall back to the local pool.
export function acceptRemote(text, name) {
    const joke = typeof text === 'string' ? text.trim() : '';
    if (!joke) return null;
    const seen = readSeen(name);
    if (seen.includes(joke)) return null;
    writeSeen(name, [...seen, joke]);
    return joke;
}
