// Pure extractor: turn a Clerk user.created/updated webhook payload (evt.data)
// into the fields we persist. No imports so it runs under `node --test`.

export function userFromClerkEvent(data) {
    if (!data || !data.id) return null;
    const emails = Array.isArray(data.email_addresses) ? data.email_addresses : [];
    const primary = emails.find((e) => e.id === data.primary_email_address_id) ?? emails[0] ?? null;
    const email = primary?.email_address ?? null;
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || null;
    const role = data.public_metadata?.role ?? null;
    const createdAtMs = typeof data.created_at === 'number' ? data.created_at : null;
    return { id: data.id, email, name, role, createdAtMs };
}
