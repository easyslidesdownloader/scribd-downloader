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
          sendEvent("status", { message: "Analyzing document..." });

          const meta = await fetchDocumentMetadata(docId);

          if (!meta.pages || meta.pages.length === 0) {
            throw new Error(
              "No public page assets found for this document. It may be restricted by Scribd."
            );
          }

          const totalPages = Math.max(meta.pageCount, meta.pages.length);
          sendEvent("init", { totalPages, title: meta.title });

          let capturedCount = 0;

          for (let i = 0; i < meta.pages.length; i++) {
            const pageItem = meta.pages[i];
            const pageNum = pageItem.pageNum;

            sendEvent("status", {
              message: `Loading page ${pageNum} of ${totalPages}...`,
              current: pageNum,
              total: totalPages,
            });

            try {
              const pageRes = await fetch(pageItem.jsonpUrl, {
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                  Referer: "https://www.scribd.com/",
                },
              });

              if (!pageRes.ok) continue;

              const rawText = await pageRes.text();

              // Parse JSONP payload: window.pageN_callback(["..."])
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

              // Find base URL for images from jsonpUrl
              const cdnBase = pageItem.jsonpUrl.substring(
                0,
                pageItem.jsonpUrl.indexOf("/pages/")
              );

              // Extract image URLs (jpeg, jpg, png)
              const imgMatches = [
                ...rawHtml.matchAll(/src="([^"]+\.(?:jpg|jpeg|png|webp))"/gi),
                ...rawHtml.matchAll(/url\(['"]?([^'"\)]+\.(?:jpg|jpeg|png|webp))['"]?\)/gi),
                ...rawHtml.matchAll(/xlink:href="([^"]+)"/gi),
              ];

              let imageSrc = "";

              if (imgMatches.length > 0 && imgMatches[0][1]) {
                const imgPath = imgMatches[0][1];
                const fullImgUrl = imgPath.startsWith("http")
                  ? imgPath
                  : `${cdnBase}/${imgPath.replace(/^\.?\/?/, "")}`;

                const imgRes = await fetch(fullImgUrl, {
                  headers: { Referer: "https://www.scribd.com/" },
                });

                if (imgRes.ok) {
                  const buffer = Buffer.from(await imgRes.arrayBuffer());
                  const mimeType = fullImgUrl.endsWith(".png") ? "image/png" : "image/jpeg";
                  imageSrc = `data:${mimeType};base64,${buffer.toString("base64")}`;
                }
              }

              // Fallback if page is pure HTML/vector text: embed as styled SVG data URI
              if (!imageSrc) {
                const svgContent = `
                  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
                    <foreignObject width="100%" height="100%">
                      <div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;background:white;font-family:sans-serif;box-sizing:border-box;overflow:hidden;position:relative;">
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
              console.warn(`Error rendering page ${pageNum}:`, pageErr);
            }
          }

          if (capturedCount === 0) {
            sendEvent("error", {
              message: "Could not load document pages. The document might be private or premium-only.",
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