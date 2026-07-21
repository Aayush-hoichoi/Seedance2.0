// Raw provider errors (BytePlus/ModelArk, Gemini) are engineer-speak —
// "task_type r2v does not support model …. Request id: 0217…". This maps the
// known failure classes to copy a user can act on, at DISPLAY time only: the
// raw message stays stored in history/jobs for debugging. Unknown errors pass
// through with the provider request id stripped.
const RULES = [
    {
        re: /task_type\s+\S+\s+does not support|does not support.*task_type/i,
        msg: 'This model doesn’t support reference-based generation — switch the model to Seedance 2.0, or use Text → Video / Image → Video instead.',
    },
    {
        re: /asset pool is still full|quota/i,
        msg: 'The reference-asset pool filled up. It’s cleaned automatically — retry in a moment; if it keeps happening, delete unused assets in BytePlus Console → Asset Library.',
    },
    {
        re: /rate.?limit|throttl|too many|too frequent|flow.?limit|qps/i,
        msg: 'Too many uploads at once — the provider is rate-limiting new reference registrations. Wait a minute and generate again.',
    },
    {
        // BytePlus moderation rejects the SOURCE VIDEO itself at asset
        // verification (InputVideoSensitiveContentDetected) — nothing about the
        // prompt is at fault, so don't send the user editing words.
        re: /InputVideoSensitiveContentDetected|input video.*sensitive/i,
        msg: 'The provider’s moderation rejected the source video (flagged as sensitive). Nothing in the prompt will fix it — trim or swap the clip, or reframe/crop the flagged shot and re-upload.',
    },
    {
        re: /sensitive/i,
        msg: 'The provider flagged the prompt or reference media as sensitive content. Adjust the prompt or swap the media and try again.',
    },
    {
        re: /insufficient.*(balance|quota|funds)|balance.*insufficient/i,
        msg: 'The provider account is out of balance — top up the BytePlus account to keep generating.',
    },
];

export function friendlyError(raw) {
    if (!raw) return raw;
    const text = String(raw);
    const rule = RULES.find((r) => r.re.test(text));
    if (rule) return rule.msg;
    // Unknown error: keep it, minus the provider's request-id tail.
    return text.replace(/\s*Request id:\s*\S+/i, '').trim();
}
