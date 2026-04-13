import { execFile } from 'child_process';
import { promisify } from 'util';

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
const PYTHON_SEARCH_TIMEOUT_MS = 15_000;
const MIN_RELEVANCE_SCORE = 2;
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
const QUERY_STOP_WORDS = new Set([
    'ニュース',
    '最新',
    '最近',
    '確認',
    '確認内容',
    '確認結果',
    '確認してください',
    '関連',
    '関連する',
    '内容',
    '概要',
    '仕組み',
    '意味',
    '可能性',
    'わかりやすく',
]);
const execFileAsync = promisify(execFile);
const PYTHON_DDG_FETCH_SCRIPT = `
import sys
import urllib.parse
import urllib.request

query = sys.argv[1]
url = "https://duckduckgo.com/lite/?q=" + urllib.parse.quote(query)
request = urllib.request.Request(
    url,
    headers={
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    },
)
with urllib.request.urlopen(request, timeout=15) as response:
    print(response.read().decode("utf-8", "ignore"))
`;

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

function extractQueryTerms(query: string): string[] {
    const normalized = sanitizeFallbackToken(query);
    return Array.from(new Set(
        normalized
            .split(/[\s,，、/・]+/)
            .map((token) => token.trim())
            .filter((token) => token.length >= 2)
            .filter((token) => !QUERY_STOP_WORDS.has(token))
            .filter((token) => !/^\d{4}年?$/.test(token))
    ));
}

function expandDomainVariants(term: string): string[] {
    const variants = [term];

    if (term.includes('暗号資産交換業')) {
        variants.push('暗号資産交換業', '暗号資産', '交換業', '交換業者', 'JVCEA', '金融庁', '仮想通貨');
    } else if (term.includes('暗号資産')) {
        variants.push('暗号資産', '仮想通貨', 'JVCEA', '金融庁');
    } else if (term.includes('交換業')) {
        variants.push('交換業', '交換業者');
    } else if (term.includes('規制緩和')) {
        variants.push('規制緩和', '規制');
    }

    return Array.from(new Set(variants.map((value) => value.trim()).filter(Boolean)));
}

function scoreSearchResult(result: WebSearchResult, query: string): number {
    const haystack = `${result.title} ${result.snippet}`.toLowerCase();
    const terms = extractQueryTerms(query);
    if (terms.length === 0) {
        return 0;
    }

    let score = 0;
    for (const term of terms) {
        const variants = expandDomainVariants(term);
        const matchedVariant = variants.find((variant) => haystack.includes(variant.toLowerCase()));
        if (!matchedVariant) {
            continue;
        }

        score += matchedVariant.length >= 4 ? 2 : 1;
    }

    return score;
}

function filterRelevantResults(results: WebSearchResult[], query: string): WebSearchResult[] {
    return results.filter((result) => scoreSearchResult(result, query) >= MIN_RELEVANCE_SCORE);
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
    const domainVariants: string[] = [];

    if (normalized.includes('暗号資産') || normalized.includes('仮想通貨')) {
        domainVariants.push(
            'JVCEA 暗号資産 交換業 規制',
            '金融庁 暗号資産 交換業',
            '暗号資産 交換業者 JVCEA',
            '仮想通貨 交換業 規制 金融庁',
        );
    }

    return Array.from(new Set([
        combined,
        broad,
        ...uniqueTokens.slice(0, SEARCH_FALLBACK_QUERY_LIMIT),
        ...domainVariants,
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

async function fetchBingRss(query: string): Promise<string> {
    const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(url, {
        headers: SEARCH_REQUEST_HEADERS,
    }, URL_VALIDATION_TIMEOUT_MS);

    if (!response.ok) {
        throw new Error(`Bing RSS request failed with status ${response.status}`);
    }

    return response.text();
}

function parseBingRssResults(xml: string): WebSearchResult[] {
    const rawResults: WebSearchResult[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;

    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(xml)) && rawResults.length < SEARCH_RESULT_SCAN_LIMIT) {
        const itemXml = match[1];
        const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/i);
        const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i);
        const descriptionMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/i);

        const title = titleMatch ? stripHtml(titleMatch[1]) : '';
        const url = linkMatch ? decodeHtml(linkMatch[1]).trim() : '';
        const snippet = descriptionMatch ? stripHtml(descriptionMatch[1]) : '';

        if (!title || !url || !/^https?:\/\//i.test(url)) {
            continue;
        }

        rawResults.push({
            title,
            url,
            snippet,
        });
    }

    return rawResults;
}

function isDuckDuckGoChallengePage(html: string): boolean {
    const normalized = html.slice(0, 12_000);
    return /Unfortunately,\s*bots use DuckDuckGo too\./i.test(normalized)
        || /anomaly-modal__title/i.test(normalized)
        || /challenge-form/i.test(normalized);
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
    // html.duckduckgo.com はサーバー環境によって bot challenge を返しやすいため、
    // ここでは実際に結果HTMLが取れた lite エンドポイントを優先して使う。
    const url = `https://duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(url, {
        headers: SEARCH_REQUEST_HEADERS,
    }, URL_VALIDATION_TIMEOUT_MS);

    if (!response.ok) {
        throw new Error(`Search request failed with status ${response.status}`);
    }

    const html = await response.text();
    if (!isDuckDuckGoChallengePage(html)) {
        return html;
    }

    // Bun の fetch だと DuckDuckGo に bot 判定されることがある。
    // その場合だけ Python 標準ライブラリへフォールバックして、結果HTMLの取得を試す。
    try {
        const { stdout } = await execFileAsync(
            'python3',
            ['-c', PYTHON_DDG_FETCH_SCRIPT, query],
            { timeout: PYTHON_SEARCH_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 2 },
        );
        if (stdout && !isDuckDuckGoChallengePage(stdout)) {
            return stdout;
        }
    } catch (error) {
        console.error(`[Web Search] Python fallback failed for "${query}":`, error);
    }

    return html;
}

function parseDuckDuckGoResults(html: string): WebSearchResult[] {
    const rawResults: WebSearchResult[] = [];
    const anchorRegex = /<a[^>]*class=['"][^'"]*(?:result__a|result-link)[^'"]*['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = anchorRegex.exec(html)) && rawResults.length < SEARCH_RESULT_SCAN_LIMIT) {
        const [, rawHref, rawTitle] = match;
        const urlValue = unwrapDuckDuckGoUrl(rawHref);
        const title = stripHtml(rawTitle);

        if (!urlValue || !title || !/^https?:\/\//i.test(urlValue)) {
            continue;
        }

        const trailingHtml = html.slice(anchorRegex.lastIndex, anchorRegex.lastIndex + 1500);
        const snippetMatch = trailingHtml.match(/<a[^>]*class=['"][^'"]*(?:result__snippet|result-snippet)[^'"]*['"][^>]*>([\s\S]*?)<\/a>/i)
            || trailingHtml.match(/<div[^>]*class=['"][^'"]*(?:result__snippet|result-snippet)[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i)
            || trailingHtml.match(/<td[^>]*class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i);
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

    if (results.length === 0 && rawResults.length > 0) {
        const fallbackResults: WebSearchResult[] = [];
        const seenRawUrls = new Set<string>();

        for (const result of rawResults) {
            if (fallbackResults.length >= limit) {
                break;
            }
            if (seenRawUrls.has(result.url)) {
                continue;
            }
            seenRawUrls.add(result.url);
            fallbackResults.push(result);
        }

        console.log('[Web Search] URL validation rejected every result, using raw search result URLs instead.');
        return fallbackResults;
    }

    return results;
}

async function searchWithBing(query: string, limit: number, relevanceQuery: string = query): Promise<WebSearchResult[]> {
    const xml = await fetchBingRss(query);
    const rawResults = parseBingRssResults(xml);
    const validated = await collectValidatedResults(rawResults, limit);
    const relevant = filterRelevantResults(validated, relevanceQuery);
    if (validated.length > 0 && relevant.length === 0) {
        console.log(`[Web Search] Bing results were discarded as irrelevant for "${relevanceQuery}".`);
    }
    return relevant;
}

async function searchWithDuckDuckGo(query: string, limit: number, relevanceQuery: string = query): Promise<WebSearchResult[]> {
    const html = await fetchDuckDuckGoHtml(query);
    const rawResults = parseDuckDuckGoResults(html);
    const validated = await collectValidatedResults(rawResults, limit);
    const relevant = filterRelevantResults(validated, relevanceQuery);
    if (validated.length > 0 && relevant.length === 0) {
        console.log(`[Web Search] DuckDuckGo results were discarded as irrelevant for "${relevanceQuery}".`);
    }
    return relevant;
}

export async function searchWeb(query: string, limit: number = 5): Promise<WebSearchResult[]> {
    const safeLimit = Math.max(1, Math.min(limit, 5));
    const attemptedQueries = [query, ...buildFallbackQueries(query)];

    for (const attemptQuery of attemptedQueries) {
        try {
            const bingResults = await searchWithBing(attemptQuery, safeLimit, query);
            if (bingResults.length > 0) {
                if (attemptQuery !== query) {
                    console.log(`[Web Search] Bing fallback query used: "${attemptQuery}" (original: "${query}")`);
                }
                return bingResults;
            }
        } catch (error) {
            console.error(`[Web Search] Bing search failed for "${attemptQuery}":`, error);
        }

        try {
            const ddgResults = await searchWithDuckDuckGo(attemptQuery, safeLimit, query);
            if (ddgResults.length > 0) {
                if (attemptQuery !== query) {
                    console.log(`[Web Search] DuckDuckGo fallback query used: "${attemptQuery}" (original: "${query}")`);
                }
                return ddgResults;
            }
        } catch (error) {
            console.error(`[Web Search] DuckDuckGo search failed for "${attemptQuery}":`, error);
        }
    }

    return [];
}
