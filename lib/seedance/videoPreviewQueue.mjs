// First-frame decoding is shared across gallery cards. A slot is held until
// the caller has captured a frame and stopped its media request (or cancelled).
export function createVideoPreviewQueue(limit = 2) {
    const pending = [];
    let active = 0;
    let draining = false;
    const drain = () => {
        if (draining) return;
        draining = true;
        try {
            while (active < limit && pending.length) {
                const job = pending.shift();
                if (job.done) continue;
                job.started = true;
                active += 1;
                job.start(job.finish);
            }
        } finally { draining = false; }
    };
    return {
        enqueue(start) {
            const job = { start, started: false, done: false };
            job.finish = () => {
                if (job.done) return;
                job.done = true;
                if (job.started) active -= 1;
                drain();
            };
            pending.push(job);
            drain();
            return job.finish;
        },
    };
}

export const videoPreviewQueue = createVideoPreviewQueue();
