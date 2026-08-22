// @ts-ignore
import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";
import { extractScribdDocId, getScribdEmbedUrl } from "@/lib/scribd";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const CHROMIUM_PACK_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar";

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

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (event: string, data: any) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };

        let browser = null;

        try {
          const docId = extractScribdDocId(url);
          const targetUrl = docId ? getScribdEmbedUrl(docId) : url;

          sendEvent("status", { message: "Launching serverless browser..." });

          if (process.env.NODE_ENV === "production") {
            chromium.setGraphicsMode = false;
            const executablePath = await chromium.executablePath(CHROMIUM_PACK_URL);

            browser = await puppeteer.launch({
              args: [
                ...chromium.args,
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--window-size=1200,1600",
              ],
              defaultViewport: { width: 1200, height: 1600, deviceScaleFactor: 1 },
              executablePath,
              headless: true,
            });
          } else {
            const executablePath = await chromium.executablePath();
            browser = await puppeteer.launch({
              args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
              ],
              defaultViewport: { width: 1200, height: 1600, deviceScaleFactor: 1 },
              executablePath,
              headless: true,
            });
          }

          const page = await browser.newPage();
          await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
          );

          sendEvent("status", { message: "Connecting to Scribd document..." });

          await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: 35000,
          });

          // Wait 2.5s for initial layout
          await new Promise((r) => setTimeout(r, 2500));

          // Un-blur pages & hide promo overlays
          await page.evaluate(() => {
            try {
              const style = document.createElement("style");
              style.innerHTML = `
                .blurred_page, .page_blur_promo, .newpage, .outer_page, [data-page] {
                  filter: none !important;
                  -webkit-filter: none !important;
                  opacity: 1 !important;
                  visibility: visible !important;
                }
                .page_blur_promo,
                .between_page_module,
                .between_page_portal_root,
                .auto_load_wrapper,
                .header_container,
                .toolbar_top,
                .document_actions,
                #banner_wrapper,
                .mobile_sticky_footer,
                .upgrade_account_btn,
                .fullscreen_btn {
                  display: none !important;
                }
              `;
              document.head?.appendChild(style);
            } catch (e) {}
          });

          // 1. Detect total pages
          const actualTotalPages = await page.evaluate(() => {
            // @ts-ignore
            if (window.scribd_doc && typeof window.scribd_doc.page_count === "number") {
              // @ts-ignore
              return window.scribd_doc.page_count;
            }
            const pageIndicator = document.querySelector(
              ".page_number, .page_count, .total_pages, [data-page-count]"
            );
            if (pageIndicator?.textContent) {
              const match = pageIndicator.textContent.match(/(?:of|\/)\s*(\d+)/i);
              if (match) return parseInt(match[1], 10);
            }

            const outerCount = document.querySelectorAll(
              "[id^='outer_page_'], .outer_page, .newpage, [data-page]"
            ).length;
            return outerCount > 0 ? outerCount : 8;
          });

          console.log(`Verified total pages: ${actualTotalPages}`);
          sendEvent("init", { totalPages: actualTotalPages });

          const capturedPages = new Set<number>();

          // 2. Iterate through each page using DOM-rect viewport clipping
          for (let pageNum = 1; pageNum <= actualTotalPages; pageNum++) {
            if (capturedPages.has(pageNum)) continue;

            sendEvent("status", {
              message: `Capturing page ${pageNum} of ${actualTotalPages}...`,
              current: pageNum,
              total: actualTotalPages,
            });

            // Scroll the target page into view and retrieve its viewport bounding coordinates
            const rect = await page.evaluate((targetNum) => {
              const selectors = [
                `#outer_page_${targetNum}`,
                `[data-page="${targetNum}"]`,
                `#page_${targetNum}`,
                `.outer_page:nth-of-type(${targetNum})`,
                `.newpage:nth-of-type(${targetNum})`,
                `div[id^="outer_page"]:nth-of-type(${targetNum})`,
              ];

              let el: HTMLElement | null = null;
              for (const sel of selectors) {
                const found = document.querySelector(sel) as HTMLElement | null;
                if (found) {
                  el = found;
                  break;
                }
              }

              if (el) {
                el.style.filter = "none";
                el.style.opacity = "1";
                el.style.display = "block";
                
                // Align top of page to top of viewport
                el.scrollIntoView({ behavior: "instant", block: "start" });

                const r = el.getBoundingClientRect();
                return {
                  x: Math.max(0, Math.floor(r.x)),
                  y: Math.max(0, Math.floor(r.y)),
                  width: Math.max(200, Math.floor(r.width || el.offsetWidth || 900)),
                  height: Math.max(200, Math.floor(r.height || el.offsetHeight || 1200)),
                };
              }

              // If not found, scroll down
              window.scrollBy(0, 900);
              return null;
            }, pageNum);

            // Wait for assets (images, fonts, SVGs) to settle
            await new Promise((r) => setTimeout(r, 400));

            try {
              let imageBuffer: Buffer | null = null;
              let clipWidth = 900;
              let clipHeight = 1200;

              if (rect && rect.width > 50 && rect.height > 50) {
                clipWidth = Math.min(1200, rect.width);
                clipHeight = Math.min(1600, rect.height);

                imageBuffer = (await page.screenshot({
                  type: "jpeg",
                  quality: 80,
                  clip: {
                    x: rect.x,
                    y: rect.y,
                    width: clipWidth,
                    height: clipHeight,
                  },
                })) as Buffer;
              } else {
                // Direct fallback: screenshot top portion of current viewport
                imageBuffer = (await page.screenshot({
                  type: "jpeg",
                  quality: 80,
                  clip: {
                    x: 0,
                    y: 0,
                    width: 1200,
                    height: 1550,
                  },
                })) as Buffer;
              }

              if (imageBuffer) {
                const pageData = {
                  pageNumber: pageNum,
                  image: `data:image/jpeg;base64,${imageBuffer.toString("base64")}`,
                  width: clipWidth,
                  height: clipHeight,
                };

                capturedPages.add(pageNum);
                sendEvent("page", pageData);
                console.log(`✓ Page ${pageNum} captured successfully`);
              }
            } catch (err) {
              console.warn(`Screenshot error for page ${pageNum}:`, err);
            }
          }

          if (capturedPages.size === 0) {
            sendEvent("error", {
              message: "No readable pages could be rendered from this document.",
            });
          } else {
            sendEvent("complete", { total: capturedPages.size });
          }
        } catch (err) {
          console.error("Stream error:", err);
          sendEvent("error", {
            message:
              err instanceof Error ? err.message : "Error extracting document",
          });
        } finally {
          if (browser) {
            await browser.close();
          }
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