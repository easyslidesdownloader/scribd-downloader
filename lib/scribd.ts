export type ScribdPageInfo = {
  pageNum: number;
  jsonpUrl: string;
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
  pages: ScribdPageInfo[];
}> {
  // Fetch the embed document HTML
  const embedUrl = `https://www.scribd.com/embeds/${docId}/content?start_page=1&view_mode=scroll`;

  const res = await fetch(embedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.scribd.com/",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to load Scribd document (HTTP ${res.status})`);
  }

  const html = await res.text();

  // 1. Extract Title
  let title = "Scribd Document";
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].replace(/ - Scribd$/i, "").trim();
  }

  // 2. Extract Total Page Count
  let pageCount = 0;
  const countMatch =
    html.match(/page_count["':\s]+(\d+)/i) ||
    html.match(/total_pages["':\s]+(\d+)/i) ||
    html.match(/"pageCount"\s*:\s*(\d+)/i) ||
    html.match(/data-page-count="(\d+)"/i);

  if (countMatch) {
    pageCount = parseInt(countMatch[1], 10);
  }

  // 3. Find Page JSONP URLs
  const pages: ScribdPageInfo[] = [];
  const foundPageNums = new Set<number>();

  // Pattern A: Direct full URLs matching scribdassets.com
  const directRegex = /(https:\/\/html\.scribdassets\.com\/[a-zA-Z0-9_\-\.]+\/pages\/(\d+)-[a-zA-Z0-9_\-\.]+\.jsonp)/gi;
  let match;
  while ((match = directRegex.exec(html)) !== null) {
    const pageNum = parseInt(match[2], 10);
    if (!foundPageNums.has(pageNum)) {
      foundPageNums.add(pageNum);
      pages.push({ pageNum, jsonpUrl: match[1] });
    }
  }

  // Pattern B: Asset prefix + page hashes in Scribd JS parameters
  if (pages.length === 0) {
    // Look for content directory or prefix (e.g. "https://html.scribdassets.com/xxxxxx/")
    const prefixMatch =
      html.match(/https:\/\/html\.scribdassets\.com\/[a-zA-Z0-9_\-\.]+\//i) ||
      html.match(/"(https:\/\/html\d*\.scribdassets\.com\/[^"]+\/)"/i);

    // Look for page filename patterns like "pages/1-xxxx.jsonp" or "1-xxxx"
    const pageHashRegex = /["'](?:pages\/)?(\d+)-([a-zA-Z0-9_\-\.]+)\.jsonp["']/gi;
    let hashMatch;

    const basePrefix = prefixMatch ? prefixMatch[0].replace(/"/g, "") : `https://html.scribdassets.com/${docId}/`;

    while ((hashMatch = pageHashRegex.exec(html)) !== null) {
      const pageNum = parseInt(hashMatch[1], 10);
      const hash = hashMatch[2];
      if (!foundPageNums.has(pageNum)) {
        foundPageNums.add(pageNum);
        const cleanUrl = `${basePrefix.replace(/\/pages\/$/, "").replace(/\/$/, "")}/pages/${pageNum}-${hash}.jsonp`;
        pages.push({ pageNum, jsonpUrl: cleanUrl });
      }
    }
  }

  pages.sort((a, b) => a.pageNum - b.pageNum);

  return {
    pageCount: pageCount || pages.length || 1,
    title,
    pages,
  };
}