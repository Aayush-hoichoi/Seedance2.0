// Does a GPT response read as a content-policy refusal instead of the long
// production brief we asked for? The styled-mode enhancer expects a multi-line
// brief (hundreds–thousands of chars); a refusal is a terse sentence or two
// ("I'm sorry, I can't assist with that request."). We gate on length first so
// a real brief that merely contains "sorry" inside dialogue is never misread.
//
// `.mjs` so both the Next route and `node --test` can load it (the repo has no
// type:module, so a plain `.js` lib isn't directly unit-testable).

const REFUSAL_RE = /\b(i'?m sorry|i am sorry|i apologi[sz]e|i can'?t (assist|help|comply|create|generate|do that|continue|fulfil|fulfill)|i cannot (assist|help|comply|create|generate|fulfil|fulfill)|i'?m (not able|unable) to|i won'?t be able to|unable to (assist|help|comply|provide)|can'?t help with (that|this)|cannot help with (that|this)|i (must|have to|will have to) decline|against (my|our|the) (policy|policies|guidelines|content policy)|violate(s|d)? (our|the) (content )?(policy|policies|guidelines))\b/i;

const MAX_REFUSAL_LEN = 600;

export function looksLikeRefusal(text) {
    if (typeof text !== 'string') return false;
    const t = text.trim();
    if (!t || t.length > MAX_REFUSAL_LEN) return false;
    return REFUSAL_RE.test(t);
}

// The authoritative signal plus the heuristic: OpenAI sets finish_reason
// 'content_filter' when its own moderation cut the response, otherwise we fall
// back to sniffing the text.
export function isRefusal({ text, finishReason } = {}) {
    return finishReason === 'content_filter' || looksLikeRefusal(text);
}
