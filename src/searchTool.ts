export interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
}

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

export async function searchWeb(query: string, limit: number = 5): Promise<WebSearchResult[]> {
    const safeLimit = Math.max(1, Math.min(limit, 5));
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
        headers: {
            'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
            'user-agent': 'Mozilla/5.0 CodexBot/1.0',
        },
    });

    if (!response.ok) {
        throw new Error(`Search request failed with status ${response.status}`);
    }

    const html = await response.text();
    const results: WebSearchResult[] = [];
    const anchorRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = anchorRegex.exec(html)) && results.length < safeLimit) {
        const [, rawHref, rawTitle] = match;
        const urlValue = unwrapDuckDuckGoUrl(rawHref);
        const title = stripHtml(rawTitle);

        if (!urlValue || !title) {
            continue;
        }

        const trailingHtml = html.slice(anchorRegex.lastIndex, anchorRegex.lastIndex + 1500);
        const snippetMatch = trailingHtml.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
            || trailingHtml.match(/<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : '';

        results.push({
            title,
            url: urlValue,
            snippet,
        });
    }

    return results;
}
