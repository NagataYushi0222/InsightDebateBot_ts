export interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
}

const SEARCH_REQUEST_HEADERS = {
    'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
    'user-agent': 'Mozilla/5.0 CodexBot/1.0',
};

const SEARCH_RESULT_SCAN_LIMIT = 12;
const URL_VALIDATION_TIMEOUT_MS = 8_000;
const SEARCH_FALLBACK_QUERY_LIMIT = 3;
const SOFT_404_PATTERNS = [
    /404/i,
    /page not found/i,
    /not found/i,
    /the page you requested could not be found/i,
    /アクセスいただいたurlには、ページまたはファイルが存在しません/i,
    /お探しのページは見つかりません/i,
    /指定されたページ.*見つかりません/i,
    /ファイルが存在しません/i,
];

function decodeHtml(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function stripHtml(text: string): string {
    return decodeHtml(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
    const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch?.[1]) {
        return decodeURIComponent(uddgMatch[1]);
    }

    return decodeHtml(rawUrl);
}

function sanitizeFallbackToken(token: string): string {
    return token
        .replace(/[「」『』（）()【】\[\],.!?！？。、:：;；"'`]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildFallbackQueries(query: string): string[] {
    const normalized = query
        .replace(/確認内容[:：]?/g, ' ')
        .replace(/確認結果[:：]?/g, ' ')
        .replace(/参照した参考番号[:：]?/g, ' ')
        .replace(/ニュースはあるか|関連するニュース|確認してください|調べて|について|ことについて|可能性がある/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const quotedTokens = Array.from(normalized.matchAll(/[「『"]([^」』"]{2,30})[」』"]/g))
        .map((match) => sanitizeFallbackToken(match[1] || ''))
        .filter(Boolean);
    const splitTokens = normalized
        .split(/[\s,，、/・]+/)
        .map(sanitizeFallbackToken)
        .filter((token) => token.length >= 2);
    const uniqueTokens = Array.from(new Set([...quotedTokens, ...splitTokens]));
    const combined = uniqueTokens.slice(0, 4).join(' ').trim();
    const broad = uniqueTokens.slice(0, 2).join(' ').trim();

    return Array.from(new Set([
        combined,
        broad,
        ...uniqueTokens.slice(0, SEARCH_FALLBACK_QUERY_LIMIT),
    ])).filter((candidate) => candidate.length >= 2 && candidate !== query);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

function looksLikeSoft404Page(text: string): boolean {
    const normalized = text.replace(/\s+/g, ' ').trim().slice(0, 8_000);
    return SOFT_404_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * 参考URLとして載せる前に、そのURLが少なくとも今アクセス可能かを確認する。
 *
 * ここでは「検索結果に出たURLをそのまま信じない」ことが重要で、
 * 404 / 410 のような明確な不在ページや、本文に "not found" が並ぶ soft 404 を弾く。
 * 一方で 401 / 403 は「存在はしているが bot からは制限されている」場合があるため許容する。
 */
async function validateSearchResultUrl(rawUrl: string): Promise<string | null> {
    try {
        const response = await fetchWithTimeout(rawUrl, {
            headers: SEARCH_REQUEST_HEADERS,
            redirect: 'follow',
        }, URL_VALIDATION_TIMEOUT_MS);

        if (response.status === 404 || response.status === 410) {
            return null;
        }

        if (response.status >= 500) {
            return null;
        }

        if (!response.ok && response.status !== 401 && response.status !== 403) {
            return null;
        }

        const resolvedUrl = response.url || rawUrl;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html') || contentType.includes('text/plain')) {
            const body = await response.text();
            if (looksLikeSoft404Page(body)) {
                return null;
            }
        }

        return resolvedUrl;
    } catch {
        return null;
    }
}

async function fetchDuckDuckGoHtml(query: string): Promise<string> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(url, {
        headers: SEARCH_REQUEST_HEADERS,
    }, URL_VALIDATION_TIMEOUT_MS);

    if (!response.ok) {
        throw new Error(`Search request failed with status ${response.status}`);
    }

    return response.text();
}

function parseDuckDuckGoResults(html: string): WebSearchResult[] {
    const rawResults: WebSearchResult[] = [];
    const anchorRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = anchorRegex.exec(html)) && rawResults.length < SEARCH_RESULT_SCAN_LIMIT) {
        const [, rawHref, rawTitle] = match;
        const urlValue = unwrapDuckDuckGoUrl(rawHref);
        const title = stripHtml(rawTitle);

        if (!urlValue || !title || !/^https?:\/\//i.test(urlValue)) {
            continue;
        }

        const trailingHtml = html.slice(anchorRegex.lastIndex, anchorRegex.lastIndex + 1500);
        const snippetMatch = trailingHtml.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
            || trailingHtml.match(/<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';

        rawResults.push({
            title,
            url: urlValue,
            snippet,
        });
    }

    return rawResults;
}

async function collectValidatedResults(rawResults: WebSearchResult[], limit: number): Promise<WebSearchResult[]> {
    const results: WebSearchResult[] = [];
    const seenResolvedUrls = new Set<string>();

    for (const result of rawResults) {
        if (results.length >= limit) {
            break;
        }

        // DuckDuckGo 検索で見つかった候補でも、すでに消えているページは参考URLにしない。
        const resolvedUrl = await validateSearchResultUrl(result.url);
        if (!resolvedUrl || seenResolvedUrls.has(resolvedUrl)) {
            continue;
        }

        seenResolvedUrls.add(resolvedUrl);
        results.push({
            ...result,
            url: resolvedUrl,
        });
    }

    return results;
}

export async function searchWeb(query: string, limit: number = 5): Promise<WebSearchResult[]> {
    const safeLimit = Math.max(1, Math.min(limit, 5));
    const attemptedQueries = [query, ...buildFallbackQueries(query)];

    for (const attemptQuery of attemptedQueries) {
        const html = await fetchDuckDuckGoHtml(attemptQuery);
        const rawResults = parseDuckDuckGoResults(html);
        const results = await collectValidatedResults(rawResults, safeLimit);
        if (results.length > 0) {
            if (attemptQuery !== query) {
                console.log(`[Web Search] Fallback query used: "${attemptQuery}" (original: "${query}")`);
            }
            return results;
        }
    }

    return [];
}
