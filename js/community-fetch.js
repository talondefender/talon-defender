// Signed community transport. Keep the deadline active until JSON is complete.
// This decoded-byte ceiling is shared with publisher prevalidation and the API.
// It includes measured baseline/overlay payloads and reserved growth headroom.
export const COMMUNITY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function fetchCommunityResponse(url, options = {}, {
    timeoutMs = 10000,
    maxBytes = COMMUNITY_MAX_RESPONSE_BYTES,
    fetchImpl = (...args) => fetch(...args),
} = {}) {
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer;
    let reader;
    const timeoutError = () => Object.assign(new Error('community fetch timed out'), {
        code: 'community_fetch_timeout',
    });
    const sizeError = () => Object.assign(new Error('community response exceeds byte limit'), {
        code: 'community_response_too_large',
    });
    const operation = (async () => {
        const response = await fetchImpl(url, {
            ...options,
            signal: controller.signal,
            redirect: 'error',
        });
        if ( response.ok === false || response.status === 204 ) {
            response.body?.cancel?.().catch(() => {});
            return response;
        }
        let data;
        if ( typeof response.body?.getReader === 'function' ) {
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            const parts = [];
            let byteLength = 0;
            for (;;) {
                const { value, done } = await reader.read();
                // Already-buffered reads can settle as microtasks without
                // giving the timer a turn; enforce the same deadline here.
                if ( Date.now() - startedAt >= timeoutMs ) { throw timeoutError(); }
                if ( done ) { break; }
                // Fetch exposes decoded chunks, including compressed responses.
                byteLength += value.byteLength;
                if ( byteLength > maxBytes ) { throw sizeError(); }
                parts.push(decoder.decode(value, { stream: true }));
            }
            parts.push(decoder.decode());
            data = JSON.parse(parts.join(''));
        } else {
            // Response-compatible adapters also remain inside the deadline.
            data = await response.json();
            if ( new TextEncoder().encode(JSON.stringify(data)).byteLength > maxBytes ) {
                throw sizeError();
            }
        }
        if ( Date.now() - startedAt >= timeoutMs ) { throw timeoutError(); }
        return {
            ok: response.ok,
            status: response.status,
            headers: response.headers,
            json: async () => data,
        };
    })();
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(timeoutError());
                    controller.abort();
                }, timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        controller.abort();
        if ( reader ) {
            reader.cancel().catch(() => {});
            try { reader.releaseLock(); } catch { }
        }
    }
}
