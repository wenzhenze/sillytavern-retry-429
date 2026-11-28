const limitCode = /^(?:429|resource_exhausted|rate[_ -]?limit(?:[_ -]?(?:exceeded|error|reached))?|too_many_requests)$/i;
const limitMessage = /\b(?:resource exhausted\.?\s+please try again later|too many requests|rate limit exceeded)\b|^\s*429\b|\b(?:error(?:\s+code)?|(?:http\s+)?status(?:\s+code)?|http)\s*[:=]?\s*429\b/i;
const permanentQuota = /\b(?:insufficient[_ -]quota|billing[_ -]hard[_ -]limit(?:[_ -]reached)?|insufficient[_ -]credits)\b/i;
const policyCode = /^(?:content[_ -]filter(?:ed|ing|[_ -]error)?|content[_ -]policy[_ -]violation|policy[_ -]violation|safety(?:[_ -](?:error|violation|filter|block(?:ed)?|policy(?:[_ -]violation)?))?|moderation[_ -](?:blocked|error)|prohibited_content|blocklist|model_armor|image_safety)$/i;
const policyLanguage = /\b(?:safety (?:polic(?:y|ies)|guidelines?|filters?|standards?|restrictions?)|(?:content|usage|acceptable use|platform) polic(?:y|ies)|community guidelines?|(?:content|safety) moderation|content_filter)\b|(?:安全|内容|使用|平台)(?:政策|规定|规则|准则|审核|限制|过滤)|违反(?:我们的|平台的)?(?:规定|政策|准则)/i;
const blockLanguage = /\b(?:block(?:ed|ing)?|filter(?:ed|ing)?|violat\w*|flagged|requires moderation|denied|disallowed|rejected|not allowed|cannot be generated)\b|拦截|屏蔽|封锁|拒绝|违规|违反|触发|过滤/i;
const refusalOpening = /^(?:(?:i(?:['’]m| am)\s+)?sorry\b|i\s+(?:can(?:not|['’]t)|(?:am\s+)?unable to|must decline)\b|as an? (?:ai|language model)\b|(?:我)?(?:很|非常)?抱歉|对不起|作为(?:一个|一名)?\s*(?:AI|人工智能|语言模型)|我(?:不能|无法|不便))/i;
const refusalAction = /\b(?:can(?:not|['’]t)|unable to|must decline|not allowed|won['’]t)\b|无法|不能|不被允许|拒绝|不便/i;
const shortEnglishRefusal = /^(?:i(?:['’]m| am)\s+)?sorry[,，.\s]+(?:but\s+)?i\s+(?:can(?:not|['’]t)|am unable to)\s+(?:help(?: you)? with|assist(?: you)? with|comply with|fulfill|answer)\s+(?:(?:that|this|your) request|that|this)[.!\s]*$/i;
const shortChineseRefusal = /^(?:我)?(?:很|非常)?抱歉[，,。\s]*(?:但是|但)?\s*我(?:无法|不能)(?:帮助(?:你|您)?|协助(?:你|您)?)?(?:完成|满足|处理|回应|回答)?(?:你的|您的|这项|这个|该)请求[.!。！\s]*$/;

export function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function decodeData(text) {
    const parsed = parseJson(text);
    return parsed === undefined ? text : parsed;
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

    return ['error', 'detail', 'response', 'message', 'status', 'statusCode', 'status_code', 'code', 'type', 'reason']
        .flatMap(key => errorDetails(value[key], depth + 1));
}

function isPolicyError(detail) {
    return policyCode.test(detail.trim()) || /\brequires moderation\b|^(?:safety policy|安全政策)[.!。！]?$/i.test(detail.trim())
        || /\bblocked\s+(?:due to|by|for)\s*[:：]?\s*(?:safety|prohibited_content)\b/i.test(detail)
        || (policyLanguage.test(detail) && blockLanguage.test(detail));
}

function isRefusal(text) {
    const lead = text.replace(/^[\s*#_]+/, '').split(/\r?\n\s*\r?\n/, 1)[0];
    return shortEnglishRefusal.test(text.trim()) || shortChineseRefusal.test(text.trim())
        || (refusalOpening.test(lead) && refusalAction.test(lead) && policyLanguage.test(lead));
}

function recordReply(state, index, message, content = message?.content) {
    const reply = state.replies.get(index) ?? { text: '', hasText: false, hasOtherContent: false, refusal: false };
    const parts = Array.isArray(content) ? content : [];
    const text = typeof content === 'string' ? content : parts.map(part => part?.thought || /^(?:thinking|reasoning)$/.test(part?.type) ? '' : part?.text ?? '').join('');
    reply.text = (reply.text + text).trimStart().slice(0, 1600);
    reply.hasText ||= Boolean(text.trim());
    reply.refusal ||= Boolean(message?.refusal) || parts.some(part => part?.type === 'refusal');
    reply.hasOtherContent ||= Boolean(message?.tool_calls?.length || message?.function_call || message?.images?.length || message?.audio)
        || parts.some(part => part?.inlineData || part?.inline_data || part?.functionCall
            || /^(?:tool_use|tool_call|image|image_url|output_image|audio|output_audio)$/.test(part?.type));
    state.replies.set(index, reply);
}

function inspectData(state, data, inspectReply) {
    if (typeof data === 'string') {
        if (inspectReply) recordReply(state, 0, null, data);
        // Plain error messages may be returned by a gateway in place of JSON.
        if (isPolicyError(data) && !isRefusal(data)) state.policyError = true;
        if (limitCode.test(data.trim()) || limitMessage.test(data)) state.rateLimit = true;
        return;
    }

    const details = errorDetails(data);
    state.permanentQuota ||= details.some(detail => permanentQuota.test(detail));
    state.rateLimit ||= details.some(detail => limitCode.test(detail.trim()) || limitMessage.test(detail));
    state.policyError ||= details.some(isPolicyError);
    state.otherError ||= Boolean(data?.error || data?.detail || data?.quota_error || data?.type === 'error'
        || (typeof data?.message === 'string' && data.message.trim()));
    if (!inspectReply || !data || typeof data !== 'object') return;

    const choices = Array.isArray(data.choices) ? data.choices : [];
    for (const [offset, choice] of choices.entries()) {
        if (!choice) continue;
        state.policyError ||= policyCode.test(choice.finish_reason ?? '');
        const message = choice.delta ?? choice.message;
        recordReply(state, choice.index ?? offset, message, message?.content ?? choice.text);
    }

    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    for (const [offset, candidate] of candidates.entries()) {
        if (!candidate) continue;
        state.policyError ||= policyCode.test(candidate.finishReason ?? '');
        recordReply(state, candidate.index ?? offset, null, candidate.content?.parts);
    }
    state.policyError ||= policyCode.test(data.promptFeedback?.blockReason ?? data.stop_reason ?? data.delta?.stop_reason ?? '');

    const message = data.delta?.message ?? data.message;
    const content = data.content ?? (data.content_block && [data.content_block]) ?? data.delta?.text ?? data.delta?.content
        ?? message?.content?.text ?? message?.content ?? message?.tool_plan ?? data.text;
    if (content != null || message || data.tool_calls || data.images || data.audio) recordReply(state, 0, message ?? data, content);
}

async function inspectStream(response, inspectReply, state, signal) {
    if (!response.body) return true;
    const reader = response.clone().body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    const decoder = new TextDecoder();
    // Cap the amount queued on the original stream during inspection.
    let remainingBytes = inspectReply ? 4 * 1024 * 1024 : 16384;
    let buffer = '';
    let sawEvent = false;
    try {
        while (remainingBytes > 0 && !signal.aborted) {
            const { value, done } = await reader.read();
            if (done) {
                if (!sawEvent && buffer.trim() && !/^\s*(?:data:|event:|:)/.test(buffer)) {
                    inspectData(state, decodeData(buffer + decoder.decode()), inspectReply);
                }
                return true;
            }
            buffer += decoder.decode(value.subarray(0, remainingBytes), { stream: true });
            remainingBytes -= value.byteLength;
            const events = buffer.split(/(?:\r\n|\n)(?:\r\n|\n)|\r\r/);
            buffer = events.pop();
            for (const event of events) {
                const data = event.split(/\r\n|\r|\n/)
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).replace(/^ /, ''))
                    .join('\n');
                if (!data) continue;
                if (data.trim() === '[DONE]') return true;
                sawEvent = true;
                inspectData(state, decodeData(data), inspectReply);
                if (!inspectReply || state.otherError) return false;
            }
        }
        return false;
    } finally {
        signal.removeEventListener('abort', cancel);
        // SillyTavern still owns the original branch.
        cancel();
    }
}

export async function getRetryReason(response, { streaming, inspectReply, customApi, signal }) {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const state = {
        replies: new Map(),
        rateLimit: response.status === 429 || limitMessage.test(response.statusText),
        policyError: !response.ok && isPolicyError(response.statusText),
    };
    let complete = false;
    try {
        if (response.ok && !contentType.includes('json') && (streaming || contentType.includes('text/event-stream'))) {
            complete = await inspectStream(response, inspectReply, state, signal);
        } else if (!contentType.includes('html') && (contentType.includes('json') || !response.ok || inspectReply)) {
            const body = await response.clone().text();
            inspectData(state, decodeData(body), response.ok && inspectReply);
            complete = true;
        }
    } catch {
        // An unreadable body can still carry an explicit HTTP error status.
    }

    if (signal.aborted || state.permanentQuota) return null;
    if (state.rateLimit) return 'retryRateLimit';
    if (state.policyError) return customApi ? 'retrySafetyError' : null;
    if (!response.ok || state.otherError || !inspectReply || !complete) return null;

    const replies = [...state.replies.values()];
    const usableReplies = replies.filter(reply => reply.hasText || reply.hasOtherContent || reply.refusal);
    if (!usableReplies.length) return 'retryEmptyReply';
    const policyNotice = reply => customApi && !isRefusal(reply.text) && isPolicyError(reply.text)
        && /^(?:\s*(?:error\b|(?:the |this |your )?(?:request|response|prompt|content|output|message)\b|blocked\b|安全|内容|请求|回复))/i.test(reply.text);
    if (usableReplies.every(reply => !reply.hasOtherContent && (reply.refusal || isRefusal(reply.text) || policyNotice(reply)))) {
        return usableReplies.some(policyNotice) ? 'retrySafetyError' : 'retrySafetyReply';
    }
    return null;
}
