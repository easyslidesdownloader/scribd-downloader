/**
 * Helper to extract Document ID and build the cleanest Scribd URL
 */
export function extractScribdDocId(url: string): string | null {
  const match = url.match(/\/document\/(\d+)/i) || url.match(/\/doc\/(\d+)/i) || url.match(/\/embeds\/(\d+)/i);
  return match ? match[1] : null;
}

export function getScribdEmbedUrl(urlOrId: string): string {
  const docId = extractScribdDocId(urlOrId) || urlOrId;
  return `https://www.scribd.com/embeds/${docId}/content?start_page=1&view_mode=scroll`;
}