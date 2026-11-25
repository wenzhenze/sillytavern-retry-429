const retryDelays = [2000, 4000, 8000];
const generationPaths = {
    openai: '/api/backends/chat-completions/generate',
    textgenerationwebui: '/api/backends/text-completions/generate',
    kobold: '/api/backends/kobold/generate',
    novel: '/api/novelai/generate',
};
const limitCode = /^(?:429|rate[_ -]?limit(?:[_ -]?(?:exceeded|error|reached))?|too_many_requests)$/i;
const limitMessage = /\b(?:resource exhausted\.?\s+please try again later|too many requests|rate limit exceeded)\b|^\s*429\b|\b(?:error(?:\s+code)?|(?:http\s+)?status(?:\s+code)?|http)\s*[:=]?\s*429\b/i;
const permanentQuota = /\b(?:insufficient[_ -]quota|billing[_ -]hard[_ -]limit(?:[_ -]reached)?|insufficient[_ -]credits)\b/i;

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function errorDetails(value, depth = 0) {
    if (depth > 4 || value == null) return [];
    if (typeof value === 'string') {
        const nested = /^[\[{]/.test(value.trimStart()) ? parseJson(value) : undefined;
        return nested ? errorDetails(nested, depth + 1) : [value];
    }
    if (typeof value === 'number') return [String(value)];
    if (Array.isArray(value)) return value.flatMap(item => errorDetails(item, depth + 1));
    if (value.quota_error === true) return ['insufficient_quota'];

    return ['error', 'detail', 'response', 'message', 'status', 'statusCode', 'status_code', 'code', 'type']
        .flatMap(key => errorDetails(value[key], depth + 1));
}

async function readFirstEvent(response) {
    if (!response.body) return '';
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let remainingBytes = 16384;

    try {
        while (remainingBytes > 0) {
            const { value, done } = await reader.read();
            if (done) return buffer + decoder.decode();
            buffer += decoder.decode(value.subarray(0, remainingBytes), { stream: true });
            remainingBytes -= value.byteLength;

            const events = buffer.split(/(?:\r\n|\n)(?:\r\n|\n)|\r\r/);
            buffer = events.pop();
            for (const event of events) {
                const data = event.split(/\r\n|\r|\n/)
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).replace(/^ /, ''))
                    .join('\n');
                if (data) return data;
            }
        }
        return '';
    } finally {
        // The original branch is still owned by SillyTavern.
        void reader.cancel().catch(() => {});
    }
}

async function isRetryable(response, streaming) {
    const contentType = response.headers.get('content-type') ?? '';
    let details = [];
    try {
        if (contentType.includes('json') || (!response.ok && !contentType.includes('html'))) {
            const text = await response.clone().text();
            details = errorDetails(parseJson(text) ?? text);
        } else if (response.ok && (streaming || contentType.includes('text/event-stream'))) {
            const data = await readFirstEvent(response);
            details = errorDetails(parseJson(data) ?? data);
        }
    } catch {
        // A response with an unreadable body can still carry HTTP 429.
    }

    if (details.some(detail => permanentQuota.test(detail))) return false;
    return response.status === 429 || [response.statusText, ...details].some(detail =>
        limitCode.test(detail.trim()) || limitMessage.test(detail));
}

function retryDelay(response, fallback) {
    const header = response.headers.get('retry-after')?.trim();
    if (!header) return fallback;
    const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    if (Number.isNaN(delay)) return fallback;
    return Math.max(fallback, delay);
}

function wait(ms, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', stop);
            resolve();
        }, ms);
        function stop() {
            clearTimeout(timer);
            reject(signal.reason);
        }
        signal.addEventListener('abort', stop, { once: true });
    });
}

const { eventSource, eventTypes } = SillyTavern.getContext();
let pendingGeneration;
let retryScope = new AbortController();

eventSource.on(eventTypes.GENERATE_AFTER_DATA, (data, dryRun) => {
    if (dryRun || document.body.dataset.generating !== 'true') return;
    const { mainApi, chatId } = SillyTavern.getContext();
    pendingGeneration = generationPaths[mainApi] && chatId != null
        ? { path: generationPaths[mainApi], chatId, data }
        : undefined;
});

eventSource.on(eventTypes.GENERATION_ENDED, () => { pendingGeneration = undefined; });

function cancelRetries() {
    pendingGeneration = undefined;
    retryScope.abort();
    retryScope = new AbortController();
}

eventSource.on(eventTypes.GENERATION_STOPPED, cancelRetries);
eventSource.on(eventTypes.CHAT_CHANGED, cancelRetries);

const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
    const fetchRequest = () => originalFetch.call(this, input, init);
    const generation = pendingGeneration;
    if (!generation || typeof input !== 'string' || input !== generation.path
        || init?.method?.toUpperCase() !== 'POST' || !init.signal || typeof init.body !== 'string'
        || SillyTavern.getContext().chatId !== generation.chatId) {
        return fetchRequest();
    }

    const payload = parseJson(init.body);
    if (!payload || (generation.path === generationPaths.openai
        ? ['quiet', 'impersonate'].includes(payload.type)
        : (payload.prompt ?? payload.input) !== (generation.data.prompt ?? generation.data.input))) {
        return fetchRequest();
    }

    pendingGeneration = undefined;
    const signal = AbortSignal.any([init.signal, retryScope.signal]);
    const streaming = payload.stream === true || payload.streaming === true;
    let response = await fetchRequest();

    for (const [index, fallback] of retryDelays.entries()) {
        if (signal.aborted || !await isRetryable(response, streaming)) break;
        signal.throwIfAborted();
        const delay = retryDelay(response, fallback);
        if (delay > 60000) break;

        // Discard the failed response only when there will be a retry.
        void response.body?.cancel().catch(() => {});
        globalThis.toastr?.info(`将在 ${Math.ceil(delay / 1000)} 秒后重试（${index + 1}/${retryDelays.length}）`, '生成限流', {
            timeOut: Math.min(delay, 5000),
        });
        await wait(delay, signal);
        signal.throwIfAborted();
        response = await originalFetch.call(this, input, { ...init, signal });
    }

    return response;
};
