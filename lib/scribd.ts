export type ScribdPageInfo = {
  pageNum: number;
  imageUrl: string;
  width: number;
  height: number;
};

export function extractScribdDocId(url: string): string | null {
  const match =
    url.match(/\/document\/(\d+)/i) ||
    url.match(/\/doc\/(\d+)/i) ||
    url.match(/\/embeds\/(\d+)/i) ||
    url.match(/^(\d+)$/);
  return match ? match[1] : null;
}

export async function fetchDocumentMetadata(docId: string): Promise<{
  pageCount: number;
  title: string;
  secretPassword?: string;
  pages: { pageNum: number; jsonpUrl: string }[];
}> {
  // Fetch the embed page HTML which contains the JSON metadata
  const embedUrl = `https://www.scribd.com/embeds/${docId}/content?start_page=1&view_mode=scroll`;
  
  const res = await fetch(embedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to load Scribd document metadata (HTTP ${res.status})`);
  }

  const html = await res.text();

  // 1. Extract JSON metadata inside the embed page
  let pageCount = 0;
  let title = "Scribd Document";

  // Try matching page count
  const pageCountMatch =
    html.match(/"page_count"\s*:\s*(\d+)/) ||
    html.match(/page_count\s*=\s*(\d+)/) ||
    html.match(/total_pages\s*=\s*(\d+)/) ||
    html.match(/data-page-count="(\d+)"/);

  if (pageCountMatch) {
    pageCount = parseInt(pageCountMatch[1], 10);
  }

  // Try matching title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].replace(/ - Scribd$/i, "").trim();
  }

  // 2. Find all page JSONP / image asset URLs in the document
  const pageUrlsMap = new Map<number, string>();
  const pageUrlRegex = /https:\/\/html\.scribdassets\.com\/[a-z0-9]+\/pages\/(\d+)-[a-z0-9]+\.jsonp/gi;
  let match;

  while ((match = pageUrlRegex.exec(html)) !== null) {
    const pageNum = parseInt(match[1], 10);
    if (!pageUrlsMap.has(pageNum)) {
      pageUrlsMap.set(pageNum, match[0]);
    }
  }

  // Fallback: If page count wasn't in the JSON, use the detected URLs length
  if (pageCount === 0) {
    pageCount = pageUrlsMap.size > 0 ? pageUrlsMap.size : 1;
  }

  const pages = [];
  for (const [pageNum, jsonpUrl] of pageUrlsMap.entries()) {
    pages.push({ pageNum, jsonpUrl });
  }
  pages.sort((a, b) => a.pageNum - b.pageNum);

  return {
    pageCount,
    title,
    pages,
  };
}