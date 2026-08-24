import {
    App,
    applyDocumentTheme,
    applyHostFonts,
    applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const root = document.querySelector('#app');
const app = new App(
    { name: 'Logline AI generation media', version: '1.0.0' },
    {},
    { autoResize: true },
);

let layout = 'gallery';
let generations = [];
let pollTimer = null;
let polling = false;
let lastError = null;

function applyHostContext(context = {}) {
    if (context.theme) applyDocumentTheme(context.theme);
    if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
    if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

function statusLabel(value) {
    return value === 'timed_out' ? 'Timed out' : `${value || 'unknown'}`.replace('_', ' ');
}

function statusClass(value) {
    if (value === 'succeeded') return 'success';
    if (['failed', 'timed_out', 'cancelled'].includes(value)) return 'failure';
    return 'pending';
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function openButton(media) {
    const button = element('button', 'open-button', 'Open original');
    button.type = 'button';
    button.addEventListener('click', async () => {
        try {
            await app.openLink({ url: media.url });
        } catch {
            window.open(media.url, '_blank', 'noopener,noreferrer');
        }
    });
    return button;
}

function mediaNode(media, generation) {
    const frame = element('div', 'media-frame');
    if (media.type === 'video') {
        const video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.src = media.url;
        video.setAttribute('aria-label', `Generated video ${generation.generationId}`);
        frame.append(video);
    } else {
        const image = document.createElement('img');
        image.src = media.url;
        image.alt = `Generated image ${generation.generationId}`;
        image.loading = 'lazy';
        frame.append(image);
    }
    frame.append(openButton(media));
    return frame;
}

function pendingNode(generation) {
    const pending = element('div', 'pending-state');
    const pulse = element('div', 'pulse');
    pulse.setAttribute('aria-hidden', 'true');
    pending.append(pulse, element('p', null,
        generation.status === 'queued' ? 'Waiting for a generation slot…' : 'Creating your media…'));
    return pending;
}

function emptyNode(generation) {
    const failed = statusClass(generation.status) === 'failure';
    const panel = element('div', `empty-state ${failed ? 'is-error' : ''}`);
    const errorMessage = typeof generation.error === 'string'
        ? generation.error
        : generation.error?.message;
    panel.append(element('p', null, errorMessage || (failed
        ? 'This generation did not complete.'
        : 'The generation completed, but no archived media is available.')));
    return panel;
}

function card(generation) {
    const article = element('article', `card ${layout === 'single' ? 'card-single' : ''}`);
    const header = element('header', 'card-header');
    const identity = element('div', 'identity');
    identity.append(
        element('span', 'generation-id', `#${generation.generationId}`),
        element('span', 'media-kind', generation.category),
    );
    const badge = element('span', `status ${statusClass(generation.status)}`, statusLabel(generation.status));
    header.append(identity, badge);
    article.append(header);

    if (!generation.terminal) article.append(pendingNode(generation));
    else if (generation.media?.length) {
        const mediaGrid = element('div', `media-grid count-${generation.media.length}`);
        generation.media.forEach((media) => mediaGrid.append(mediaNode(media, generation)));
        article.append(mediaGrid);
    } else article.append(emptyNode(generation));

    if (generation.modelId) article.append(element('footer', 'card-footer', generation.modelId));
    return article;
}

function render() {
    root.replaceChildren();
    root.className = layout === 'single' ? 'single' : 'gallery';
    if (lastError) root.append(element('div', 'global-error', lastError));
    if (!generations.length) {
        root.append(element('div', 'initial-state', 'Preparing media…'));
        return;
    }
    generations.forEach((generation) => root.append(card(generation)));
}

function mergeGeneration(next) {
    const index = generations.findIndex((item) => item.generationId === next.generationId);
    if (index === -1) generations.push(next);
    else generations[index] = next;
}

function nextPollDelay() {
    const active = generations.filter((item) => !item.terminal);
    if (active.length) return Math.max(2000, Math.min(...active.map((item) => item.pollAfterMs || 3000)));

    // Refresh terminal media shortly before its signed URL expires. The app
    // therefore never keeps playing a URL after the credential window closes.
    const expiries = generations.flatMap((item) => item.media || [])
        .map((media) => Date.parse(media.expiresAt))
        .filter(Number.isFinite);
    if (!expiries.length) return null;
    return Math.max(3000, Math.min(...expiries) - Date.now() - 5 * 60 * 1000);
}

function schedulePoll() {
    clearTimeout(pollTimer);
    const delay = nextPollDelay();
    if (delay === null) return;
    pollTimer = setTimeout(refreshGenerations, Math.min(delay, 2_000_000_000));
}

async function refreshGenerations() {
    if (polling || !generations.length) return;
    polling = true;
    lastError = null;
    try {
        for (const generation of [...generations]) {
            const expiringSoon = (generation.media || []).some((media) => {
                const expires = Date.parse(media.expiresAt);
                return Number.isFinite(expires) && expires - Date.now() <= 5 * 60 * 1000;
            });
            if (generation.terminal && !expiringSoon) continue;
            const result = await app.callServerTool({
                name: 'get_job_status',
                arguments: { generationId: generation.generationId },
            });
            if (result.isError) throw new Error('The status refresh was rejected.');
            const refreshed = result.structuredContent?.generations?.[0];
            if (refreshed) mergeGeneration(refreshed);
        }
    } catch (error) {
        lastError = error?.message || 'Could not refresh generation status.';
    } finally {
        polling = false;
        render();
        schedulePoll();
    }
}

function acceptResult(result) {
    const data = result?.structuredContent;
    if (!Array.isArray(data?.generations)) return;
    layout = data.layout === 'single' ? 'single' : 'gallery';
    generations = data.generations;
    lastError = result.isError ? 'The media result could not be loaded.' : null;
    render();
    schedulePoll();
}

app.ontoolresult = acceptResult;
app.onhostcontextchanged = (context) => applyHostContext(context);
app.onteardown = async () => {
    clearTimeout(pollTimer);
    return {};
};

render();
async function start() {
    try {
        await app.connect();
        applyHostContext(app.getHostContext());
    } catch (error) {
        lastError = error?.message || 'Could not connect the media app to this chat.';
        render();
    }
}

start();
