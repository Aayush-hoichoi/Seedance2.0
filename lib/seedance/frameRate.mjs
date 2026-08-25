// Turn requestVideoFrameCallback metadata into a stable frame-rate estimate.
// Browser decoders can skip a frame while playback starts, so the first pair
// is not representative. The median of consecutive rates ignores that warm-up
// outlier while still preserving fractional rates such as 23.976 and 29.97.
export function estimateFrameRate(samples) {
    if (!Array.isArray(samples) || samples.length < 2) return null;

    const rates = [];
    for (let i = 1; i < samples.length; i += 1) {
        const dt = samples[i].mediaTime - samples[i - 1].mediaTime;
        const df = samples[i].presentedFrames - samples[i - 1].presentedFrames;
        const rate = df / dt;
        if (dt > 0 && df > 0 && Number.isFinite(rate)) rates.push(rate);
    }
    if (!rates.length) return null;

    rates.sort((a, b) => a - b);
    const middle = Math.floor(rates.length / 2);
    return rates.length % 2
        ? rates[middle]
        : (rates[middle - 1] + rates[middle]) / 2;
}
