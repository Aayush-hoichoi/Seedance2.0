// provider_id → adapter. Every adapter implements the same submit/poll/cancel
// contract (plain result objects, never throws), so the queue stays
// provider-blind.
//
// This registry exists because the dispatch used to be an if/else with byteplus
// as the implicit default: `google` took the interactive branch and EVERYTHING
// else was submitted to, polled against and cancelled through ModelArk. Adding a
// third provider that way fails silently and in three different places
// (submit, pollRunningJobs, cancelJob), so the mapping lives in one file that
// both the processor and the cancel path import.
//
// Unknown ids fall back to byteplus so legacy job rows (written before
// provider_id was reliably set) keep resolving.

import * as byteplus from './byteplus.mjs';
import * as google from './google.mjs';
import * as kie from './kie.mjs';

export const ADAPTERS = { byteplus, google, kie };

export function adapterFor(providerId) {
    return ADAPTERS[providerId] || byteplus;
}
