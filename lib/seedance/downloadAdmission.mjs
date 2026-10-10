// Fluid compute can send concurrent requests to one process. A single 4K
// encode needs most of its memory budget, so reject overlapping conversions
// instead of queueing them behind the function's execution deadline.
let conversionActive = false;

export function acquireDownloadConversion() {
    if (conversionActive) return null;
    conversionActive = true;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        conversionActive = false;
    };
}

// Hold the slot through delivery, including buffered responses. On cancel,
// wait for the actual encoder (or ZIP iterator) to stop before admitting the
// next request. A disconnected client must not leave an encoder running next
// to the next one, nor leave the slot permanently occupied.
export function holdConversionResponse(response, signal, release, settled, cancelConversion) {
    if (!response.body) { release(); return response; }
    const reader = response.body.getReader();
    let controller;
    let stopped = false;
    let finishing;
    const finish = (cancel, reason) => {
        if (finishing) return finishing;
        stopped = true;
        signal?.removeEventListener('abort', abort);
        finishing = (async () => {
            try {
                if (cancel) {
                    cancelConversion?.();
                    await reader.cancel(reason).catch(() => {});
                }
                await settled;
            } finally {
                reader.releaseLock();
                release();
            }
        })();
        return finishing;
    };
    const abort = () => {
        if (stopped) return;
        const error = new DOMException('The download was aborted.', 'AbortError');
        controller.error(error);
        void finish(true, error);
    };
    const body = new ReadableStream({
        start(value) {
            controller = value;
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        },
        async pull() {
            try {
                const { done, value } = await reader.read();
                if (stopped) return;
                if (done) {
                    await finish(false);
                    controller.close();
                } else controller.enqueue(value);
            } catch (error) {
                if (stopped) return;
                controller.error(error);
                await finish(true, error);
            }
        },
        cancel(reason) { return finish(true, reason); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
