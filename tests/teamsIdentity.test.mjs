// Who may decide a budget request from Teams.
//
// THE POINT OF THIS FILE: a person's Teams identity and their identity in this
// app are different accounts with different email addresses, and that is the
// NORMAL case, not an anomaly to be fixed.
//
//   swapnanil.manna@hoichoi.tv     ← Teams / Entra (AAD 2b436b3a-…)
//   swapnanil.logline@gmail.com    ← the admin account in this app
//   swapnanilmanna06694@gmail.com  ← the same human's member account
//
// None of those match. Matching by email would resolve to nothing for this
// admin while appearing to work for colleagues who DO have @hoichoi.tv accounts
// in the app — a bug that fires for some people and not others. Matching by
// name is worse: two accounts here share the name "Swapnanil Manna", one admin
// and one member, so a name match could authorise the wrong one.
//
// Authorization is therefore by EXACT AAD object id and nothing else. These
// tests exist so that a later "improvement" that adds an email or name fallback
// fails loudly instead of quietly widening who can approve budgets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTeamsAdmin } from '../lib/teams/identity.mjs';

const AAD_ADMIN = '2b436b3a-cf2d-470b-b6ca-817d7c026ca3';
const AAD_STRANGER = '00000000-0000-0000-0000-000000000000';

// Deliberately mismatched: the app email shares no domain with the Teams one.
const ADMIN_ROW = {
    id: 'user_admin', email: 'swapnanil.logline@gmail.com',
    name: 'Swapnanil Manna', role: 'admin',
};
const MEMBER_ROW = {
    id: 'user_member', email: 'swapnanilmanna06694@gmail.com',
    name: 'Swapnanil Manna', role: 'member',   // same NAME as the admin
};

// Stub of the tagged-template client: returns rows for whichever aad id the
// query bound, so the test exercises the real lookup shape.
function stubSql(byAadId) {
    return (_strings, ...values) => Promise.resolve(byAadId[values[0]] ? [byAadId[values[0]]] : []);
}

function withApprovers(ids, fn) {
    const saved = process.env.TEAMS_ADMIN_AAD_IDS;
    process.env.TEAMS_ADMIN_AAD_IDS = ids;
    return Promise.resolve(fn()).finally(() => { process.env.TEAMS_ADMIN_AAD_IDS = saved; });
}

test('an admin resolves even though their Teams email differs from their app email', () =>
    withApprovers(AAD_ADMIN, async () => {
        const result = await resolveTeamsAdmin(AAD_ADMIN, { sql: stubSql({ [AAD_ADMIN]: ADMIN_ROW }) });
        assert.equal(result.ok, true, 'a mismatched email must not block a linked admin');
        assert.equal(result.admin.userId, 'user_admin');
        // The APP account is the actor written to audit_log — not the Teams one.
        // That is what makes a Teams decision indistinguishable from a console one.
        assert.equal(result.admin.email, 'swapnanil.logline@gmail.com');
    }));

test('the Teams email is never what authorises — only the linked object id', () =>
    withApprovers(AAD_ADMIN, async () => {
        // Same allowlisted id, but nothing is linked to it in the database.
        const result = await resolveTeamsAdmin(AAD_ADMIN, { sql: stubSql({}) });
        assert.equal(result.ok, false);
        assert.match(result.reason, /not linked/, 'must say the link is missing, not "forbidden"');
    }));

test('a same-name non-admin account cannot approve', () =>
    withApprovers(AAD_ADMIN, async () => {
        // The member account shares the admin's display name. If anything ever
        // matched on name, this is the row it would find.
        const result = await resolveTeamsAdmin(AAD_ADMIN, { sql: stubSql({ [AAD_ADMIN]: MEMBER_ROW }) });
        assert.equal(result.ok, false);
        assert.match(result.reason, /not an admin/);
    }));

test('an id outside the approver allowlist never reaches the database', () =>
    withApprovers(AAD_ADMIN, async () => {
        let queried = false;
        const sql = (...args) => { queried = true; return stubSql({ [AAD_STRANGER]: ADMIN_ROW })(...args); };
        const result = await resolveTeamsAdmin(AAD_STRANGER, { sql });
        assert.equal(result.ok, false);
        assert.match(result.reason, /not an approver/);
        assert.equal(queried, false, 'the allowlist is checked first, so a stranger costs no query');
    }));

test('an activity with no aadObjectId is rejected', () =>
    withApprovers(AAD_ADMIN, async () => {
        for (const missing of [undefined, null, '', '   ']) {
            const result = await resolveTeamsAdmin(missing, { sql: stubSql({}) });
            assert.equal(result.ok, false, `${JSON.stringify(missing)} must not authorise`);
        }
    }));

test('an empty approver list authorises nobody', () =>
    withApprovers('', async () => {
        const result = await resolveTeamsAdmin(AAD_ADMIN, { sql: stubSql({ [AAD_ADMIN]: ADMIN_ROW }) });
        assert.equal(result.ok, false, 'unconfigured must fail closed, never open');
    }));

// --- the configured list and the linked accounts must agree ------------------
//
// TEAMS_ADMIN_AAD_IDS decides BOTH who receives a card and who may act on one.
// If those two sets drift, someone gets an actionable card whose buttons always
// fail — the worst failure shape, because it looks like a broken product rather
// than a missing link.

test('describeApprovers reports every configured id as linked or not', () =>
    withApprovers(`${AAD_ADMIN},${AAD_STRANGER}`, async () => {
        const { describeApprovers } = await import('../lib/teams/identity.mjs');
        const rows = await describeApprovers({ sql: stubSql({ [AAD_ADMIN]: ADMIN_ROW }) });
        assert.equal(rows.length, 2, 'every configured id is accounted for');

        const linked = rows.find((r) => r.aadObjectId === AAD_ADMIN);
        assert.equal(linked.linked, true);
        assert.equal(linked.admin.email, 'swapnanil.logline@gmail.com');

        const orphan = rows.find((r) => r.aadObjectId === AAD_STRANGER);
        assert.equal(orphan.linked, false, 'an id with no account must be reported, not ignored');
        assert.ok(orphan.reason, 'and must say why, so the operator knows the fix');
    }));

test('a configured id linked to a NON-admin is reported as unusable', () =>
    withApprovers(AAD_ADMIN, async () => {
        const { describeApprovers } = await import('../lib/teams/identity.mjs');
        const [row] = await describeApprovers({ sql: stubSql({ [AAD_ADMIN]: MEMBER_ROW }) });
        assert.equal(row.linked, false, 'a linked member is not an approver');
        assert.match(row.reason, /not an admin/);
    }));
