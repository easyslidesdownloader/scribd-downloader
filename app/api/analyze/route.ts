import { extractScribdDocId, fetchDocumentMetadata } from "@/lib/scribd";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const url = body?.url;

    if (!url || typeof url !== "string") {
      return new Response(
        JSON.stringify({ error: "Please provide a valid Scribd URL." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const docId = extractScribdDocId(url);
    if (!docId) {
      return new Response(
        JSON.stringify({ error: "Invalid Scribd document URL or ID." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (event: string, data: any) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };

        try {
          sendEvent("status", { message: "Fetching document structure..." });

          // 1. Get document metadata & asset map
          const meta = await fetchDocumentMetadata(docId);

          if (!meta.pages || meta.pages.length === 0) {
            // Fallback: If direct JSONP URLs weren't embedded in HTML, construct standard CDN format
            sendEvent("status", { message: "Parsing document pages..." });
          }

          const totalPages = Math.max(meta.pageCount, meta.pages.length);
          sendEvent("init", { totalPages, title: meta.title });

          let capturedCount = 0;

          // 2. Fetch and render each page asset
          for (let i = 0; i < meta.pages.length; i++) {
            const pageItem = meta.pages[i];
            const pageNum = pageItem.pageNum;

            sendEvent("status", {
              message: `Loading page ${pageNum} of ${totalPages}...`,
              current: pageNum,
              total: totalPages,
            });

            try {
              // Fetch page JSONP containing SVG / HTML / Image layers
              const pageRes = await fetch(pageItem.jsonpUrl, {
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                  "Referer": "https://www.scribd.com/",
                },
              });

              if (!pageRes.ok) continue;

              const rawText = await pageRes.text();

              // Extract the HTML/SVG payload from window.pageN_callback(["..."])
              const jsonpMatch = rawText.match(
                /window\.page\d+_callback\(\s*(\[[\s\S]*\])\s*\);?/
              );

              if (!jsonpMatch) continue;

              const payloadArray = JSON.parse(jsonpMatch[1]);
              const rawHtml = payloadArray[0] || "";

              // Extract dimensions
              const widthMatch = rawHtml.match(/width:\s*(\d+)px/i);
              const heightMatch = rawHtml.match(/height:\s*(\d+)px/i);
              const width = widthMatch ? parseInt(widthMatch[1], 10) : 900;
              const height = heightMatch ? parseInt(heightMatch[1], 10) : 1200;

              // Check if page has an embedded background image (JPEG / PNG)
              const imgMatch =
                rawHtml.match(/src="([^"]+\.(?:jpg|jpeg|png))"/i) ||
                rawHtml.match(/url\(['"]?([^'"\)]+\.(?:jpg|jpeg|png))['"]?\)/i) ||
                rawHtml.match(/xlink:href="([^"]+)"/i);

              let imageSrc = "";

              if (imgMatch && imgMatch[1]) {
                const relativeUrl = imgMatch[1];
                imageSrc = relativeUrl.startsWith("http")
                  ? relativeUrl
                  : `https://html.scribdassets.com/${docId}/images/${relativeUrl.replace(/^\.?\/?images\//, "")}`;

                // Fetch the image buffer and convert to base64 so client renders offline
                const imgRes = await fetch(imageSrc, {
                  headers: { "Referer": "https://www.scribd.com/" },
                });

                if (imgRes.ok) {
                  const buffer = Buffer.from(await imgRes.arrayBuffer());
                  imageSrc = `data:image/jpeg;base64,${buffer.toString("base64")}`;
                }
              }

              // If no raster image was found, create clean SVG data URI
              if (!imageSrc) {
                const svgContent = `
                  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
                    <foreignObject width="100%" height="100%">
                      <div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;background:white;font-family:sans-serif;padding:20px;box-sizing:border-box;">
                        ${rawHtml}
                      </div>
                    </foreignObject>
                  </svg>
                `;
                imageSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`;
              }

              capturedCount++;
              sendEvent("page", {
                pageNumber: pageNum,
                image: imageSrc,
                width,
                height,
              });
            } catch (pageErr) {
              console.warn(`Error on page ${pageNum}:`, pageErr);
            }
          }

          if (capturedCount === 0) {
            sendEvent("error", {
              message: "Unable to parse pages from this document. Please check the URL.",
            });
          } else {
            sendEvent("complete", { total: capturedCount });
          }
        } catch (err) {
          console.error("Analysis error:", err);
          sendEvent("error", {
            message: err instanceof Error ? err.message : "Error analyzing document.",
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Server error",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}