// Keep malformed or partial API data out of the compact header chip. The
// object is also the single vocabulary used by its visual label and tooltip.
export function normalizeSpendRank(value) {
    const rank = Number(value?.rank);
    const userCount = Number(value?.userCount);
    if (!Number.isInteger(rank) || rank < 1) return null;

    const validCount = Number.isInteger(userCount) && userCount >= rank ? userCount : null;
    return {
        rank,
        userCount: validCount,
        label: `#${rank}`,
        detail: validCount ? `#${rank} of ${validCount}` : `#${rank}`,
    };
}
