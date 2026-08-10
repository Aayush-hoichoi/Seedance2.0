// Asset-group naming, shared by the client (assetsClient.js) and server
// (assetsServer.js) helpers.
//
// This lives in its OWN module, with deliberately NO 'use client', because
// assetsClient.js carries that directive: importing anything from it into a
// server module turns the export into a client reference, and calling one
// server-side throws "Attempted to call uploadGroupName() from the server".
// assetsServer.js had imported it from there and called it inside
// ensureUploadGroup() — latent, since only the MCP register_asset path reaches
// it — until a module-level call made the same mistake fail the build outright.
// Pure string helpers with no runtime of their own, so both sides can share
// them safely.

export const UPLOAD_GROUP_NAME = 'Seedance Studio';

// Each gateway project gets its OWN BytePlus asset group so references are
// hard-partitioned per project (uploads, browse and cleanup never cross over).
// Keyed by project id for stability across renames; the legacy single
// "Seedance Studio" group is still used when no project is given (pre-gateway
// / no-project setups). Every name starts with UPLOAD_GROUP_NAME, which is what
// the sweeps match on to tell studio groups from a user's own library.
export function uploadGroupName(project) {
    if (!project?.id) return UPLOAD_GROUP_NAME;
    const label = project.name ? ` · ${String(project.name).slice(0, 40)}` : '';
    return `${UPLOAD_GROUP_NAME}${label} #${project.id}`;
}
