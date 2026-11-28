import { getRetryReason, parseJson } from './retry-response.js';

const settingsKey = 'sillytavern-retry-429';
const settingFields = {
    retryRateLimit: { initial: true },
    retrySafetyError: { initial: true },
    retrySafetyReply: { initial: true },
    retryEmptyReply: { initial: true },
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
const retryReasonLabels = {
    retryRateLimit: '生成限流',
    retrySafetyError: '接口安全政策拦截',
    retrySafetyReply: '安全政策拒答',
    retryEmptyReply: '空回复',
};

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
        if (typeof initial === 'boolean') return [key, typeof value === 'boolean' ? value : initial];
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
        const checkbox = input.type === 'checkbox';
        if (checkbox) {
            input.checked = settings[key];
        } else {
            const { min, max } = settingFields[key];
            input.min = String(min);
            input.max = String(max);
            input.value = String(settings[key]);
        }
        input.addEventListener('change', () => {
            if (!input.reportValidity()) return;
            extensionSettings[settingsKey] = { ...readSettings(), [key]: checkbox ? input.checked : input.valueAsNumber };
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
    const settings = readSettings();
    const customApi = payload.chat_completion_source === 'custom';
    const inspectReply = generation.path === generationPaths.openai
        && (settings.retryEmptyReply || settings.retrySafetyReply || (customApi && settings.retrySafetyError));
    if (!settings.retryRateLimit && !inspectReply) return fetchRequest();

    const { maxRetries, firstDelay, secondDelay, repeatDelay } = settings;
    const retryDelays = [firstDelay, secondDelay, repeatDelay].map(seconds => seconds * 1000);
    let response = await originalFetch.call(this, input, { ...init, signal });

    let retryCount = 0;
    while (!signal.aborted && (maxRetries === 0 || retryCount < maxRetries)) {
        const reason = await getRetryReason(response, { streaming, inspectReply, customApi, signal });
        signal.throwIfAborted();
        if (!reason || !settings[reason]) break;
        const fallback = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
        const delay = retryDelay(response, fallback);
        retryCount++;

        // Discard the failed response only when there will be a retry.
        void response.body?.cancel().catch(() => {});
        globalThis.toastr?.info(`将在 ${Math.ceil(delay / 1000)} 秒后进行第 ${retryCount} 次重试`, retryReasonLabels[reason], {
            timeOut: Math.min(delay, 5000),
        });
        await wait(delay, signal);
        signal.throwIfAborted();
        response = await originalFetch.call(this, input, { ...init, signal });
    }

    return response;
};
