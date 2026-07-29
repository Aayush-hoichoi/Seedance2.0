// Reference order determines labels such as Image 1 / Video 1 and the order
// sent to the provider, so reordering must update the source array itself.
export function moveItem(items, from, to) {
    if (!Array.isArray(items)) return [];
    if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];

    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}
