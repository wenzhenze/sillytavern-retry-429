const settingsKey = 'sillytavern-retry-429';
const settingFields = {
    maxRetries: { initial: 0, min: 0, max: 99999 },
    firstDelay: { initial: 2, min: 1, max: 86400 },
    secondDelay: { initial: 4, min: 1, max: 86400 },
    repeatDelay: { initial: 8, min: 1, max: 86400 },
};
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
    if (!Number.isSafeInteger(delay)) return fallback;
    return Math.max(fallback, delay);
}

async function wait(ms, signal) {
    const deadline = Date.now() + ms;
    while (ms > 0) {
        signal.throwIfAborted();
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', stop);
                resolve();
            }, Math.min(ms, 2_147_483_647));
            function stop() {
                clearTimeout(timer);
                reject(signal.reason);
            }
            signal.addEventListener('abort', stop, { once: true });
        });
        ms = deadline - Date.now();
    }
}

const { eventSource, eventTypes, extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
let pendingGeneration;
let retryScope = new AbortController();

function readSettings() {
    const saved = extensionSettings[settingsKey];
    return Object.fromEntries(Object.entries(settingFields).map(([key, { initial, min, max }]) => {
        const value = saved?.[key];
        return [key, Number.isInteger(value) && value >= min && value <= max ? value : initial];
    }));
}

async function mountSettings() {
    const container = document.querySelector('#extensions_settings2');
    if (!container) return;
    const template = await fetch(new URL('./settings.html', import.meta.url));
    if (!template.ok) throw new Error(`Settings template returned HTTP ${template.status}`);
    container.insertAdjacentHTML('beforeend', await template.text());

    const settings = readSettings();
    const inputs = container.querySelectorAll('#sillytavern-retry-429-settings input');
    for (const input of inputs) {
        const key = input.name;
        const { min, max } = settingFields[key];
        input.min = String(min);
        input.max = String(max);
        input.value = String(settings[key]);
        input.addEventListener('change', () => {
            if (!input.reportValidity()) return;
            extensionSettings[settingsKey] = { ...readSettings(), [key]: input.valueAsNumber };
            saveSettingsDebounced();
        });
    }
}

void mountSettings().catch(error => console.error('429 自动重试设置加载失败', error));

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
    const { maxRetries, firstDelay, secondDelay, repeatDelay } = readSettings();
    const retryDelays = [firstDelay, secondDelay, repeatDelay].map(seconds => seconds * 1000);
    let response = await fetchRequest();

    let retryCount = 0;
    while (!signal.aborted && (maxRetries === 0 || retryCount < maxRetries) && await isRetryable(response, streaming)) {
        signal.throwIfAborted();
        const fallback = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
        const delay = retryDelay(response, fallback);
        retryCount++;

        // Discard the failed response only when there will be a retry.
        void response.body?.cancel().catch(() => {});
        globalThis.toastr?.info(`将在 ${Math.ceil(delay / 1000)} 秒后进行第 ${retryCount} 次重试`, '生成限流', {
            timeOut: Math.min(delay, 5000),
        });
        await wait(delay, signal);
        signal.throwIfAborted();
        response = await originalFetch.call(this, input, { ...init, signal });
    }

    return response;
};
