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
    // Four unrelated failures all say "quota", and this rule used to be a bare
    // /quota/i that claimed every one of them was a full asset pool — so a user
    // who had simply run out of BUDGET was told to go delete assets in the
    // BytePlus console. They are split below, most specific first; the
    // rate-limit rule must stay ahead of the capacity one, because BytePlus's
    // own throttle code (QuotaWriteQPMExceeded) contains the word Quota.
    {
        re: /rate.?limit|throttl|too many|too frequent|flow.?limit|qp[sm]/i,
        msg: 'Too many uploads at once — the provider is rate-limiting new reference registrations. Wait a minute and generate again.',
    },
    {
        // This workspace's own spend cap, from the gateway (QUOTA_EXCEEDED).
        // Nothing about the provider or the asset pool is wrong.
        re: /budget or quota limit|budget limit reached|QUOTA_EXCEEDED/i,
        msg: 'This generation would exceed the lifetime budget for your project. Ask an admin to raise the cap.',
    },
    {
        // The upstream provider's own billing quota — Gemini says "You exceeded
        // your current quota, please check your plan and billing details".
        // Only a billing/plan change fixes it; deleting assets does nothing.
        re: /exceeded your current quota|plan and billing|billing details/i,
        msg: 'The AI provider’s account has hit its own billing quota. Raise the spend cap or billing limit on the provider account — retrying or deleting assets won’t help.',
    },
    {
        // Genuine capacity exhaustion: BytePlus's own wording ("Asset quota
        // exceeded: the shared pool is full") and the message
        // createWithQuotaRecovery throws after sweeping and still failing.
        // Both name the ASSET pool — which is what the advice below acts on.
        re: /asset pool is still full|asset quota|pool is full/i,
        msg: 'The reference-asset pool filled up. It’s cleaned automatically — retry in a moment; if it keeps happening, delete unused assets in BytePlus Console → Asset Library.',
    },
    {
        // BytePlus moderation rejects the SOURCE VIDEO itself at asset
        // verification (InputVideoSensitiveContentDetected) — nothing about the
        // prompt is at fault, so don't send the user editing words.
        re: /InputVideoSensitiveContentDetected|input video.*sensitive/i,
        msg: 'The provider’s moderation rejected the source video (flagged as sensitive). Nothing in the prompt will fix it — trim or swap the clip, or reframe/crop the flagged shot and re-upload.',
    },
    {
        // A reference IMAGE flagged as a real person. Post-fix these are
        // verified as assets and should pass; if one still trips, the image
        // itself is the problem.
        re: /input image may contain real person|image may contain real person/i,
        msg: 'The provider flagged a reference image as containing a real person. Swap that image or crop the face out, then generate again.',
    },
    {
        // OUTPUT moderation on the generated AUDIO — the run succeeded, the
        // spoken dialogue got flagged. Turning Audio off skips it entirely.
        re: /output audio.*sensitive/i,
        msg: 'The generated audio was flagged as sensitive (usually the spoken dialogue). Soften or remove the dialogue, or turn Audio off, and generate again.',
    },
    {
        // OUTPUT moderation for copyright (usually the generated video).
        re: /copyright/i,
        msg: 'The generated video was flagged for possible copyright. Change the referenced style or material — or swap the reference — and generate again.',
    },
    {
        // Any other OUTPUT-side sensitivity flag (video/image content).
        re: /output.*(sensitive|moderation|flagged)/i,
        msg: 'The generated output was flagged by the provider’s moderation. Adjust the prompt or references and generate again.',
    },
    {
        // A referenced asset:// id no longer exists — a reused ref whose
        // library asset was cleaned up before the render started.
        re: /specified asset.*not found|asset .*is not found/i,
        msg: 'A reference expired before the render started. Re-attach it (or use Reuse) and generate again.',
    },
    {
        re: /sensitive/i,
        msg: 'The provider flagged the prompt or reference media as sensitive content. Adjust the prompt or swap the media and try again.',
    },
    {
        // Source media failed asset verification with NO reason returned — the
        // generic fallback from pollAssetActive. Empirically this is a
        // moderation flag on the content, not a real format/size problem.
        re: /asset verification failed|didn.t pass verification|verification failed.*format/i,
        msg: 'The source media didn’t pass the provider’s verification and no reason was returned — this is usually a moderation flag on the content. Trim or swap the clip, or re-crop the flagged shot, and re-upload.',
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
