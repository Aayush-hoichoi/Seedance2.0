import { isTerminalGenerationStatus } from './media.mjs';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForGenerations({
    load,
    advance = null,
    timeoutMs = 15_000,
    intervalMs = 1_000,
    now = Date.now,
    sleep = defaultSleep,
}) {
    const startedAt = now();
    const deadline = startedAt + Math.max(0, timeoutMs);
    let jobs = [];

    for (;;) {
        if (advance) await advance();
        jobs = await load();
        const allTerminal = jobs.length > 0 && jobs.every((job) => isTerminalGenerationStatus(job.status));
        if (allTerminal) return { jobs, allTerminal: true, timedOut: false };

        const remaining = deadline - now();
        if (remaining <= 0) return { jobs, allTerminal: false, timedOut: true };
        await sleep(Math.min(intervalMs, remaining));
    }
}
