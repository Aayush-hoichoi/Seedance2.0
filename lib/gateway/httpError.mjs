// Machine-readable error contract (design §7): every gateway error is
// { code, message, ...detail } with a stable code the UI can switch on.

import { NextResponse } from 'next/server';

export const STATUS = {
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    MODEL_ACCESS_DENIED: 403,
    NOT_A_PROJECT_MEMBER: 403,
    NOT_FOUND: 404,
    PROJECT_PAUSED: 409,
    BUDGET_CONFLICT: 409,
    BUDGET_CAP_TOO_LOW: 409,
    QUOTA_EXCEEDED: 429,
    QUEUE_FULL: 429,
    BAD_REQUEST: 400,
    DB_UNAVAILABLE: 503,
};

export function apiError(code, message, detail = {}) {
    return NextResponse.json({ code, message, ...detail }, { status: STATUS[code] ?? 400 });
}
