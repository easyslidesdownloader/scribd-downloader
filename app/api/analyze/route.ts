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
              args: chromium.args,
              defaultViewport: { width: 1200, height: 1600, deviceScaleFactor: 1.2 },
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
              defaultViewport: { width: 1200, height: 1600, deviceScaleFactor: 1.2 },
              executablePath,
              headless: true,
            });
          }

          const page = await browser.newPage();
          await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
          );

          sendEvent("status", { message: "Loading document structure..." });

          await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });

          // Un-blur pages & remove overlays safely via DOM injection
          await page.evaluate(() => {
            try {
              const style = document.createElement("style");
              style.innerHTML = `
                .blurred_page, .page_blur_promo {
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
                .upgrade_account_btn {
                  display: none !important;
                }
              `;
              document.head?.appendChild(style);
            } catch (e) {
              console.warn("Could not inject custom style tag", e);
            }
          });

          // Determine total pages
          const actualTotalPages = await page.evaluate(() => {
            // @ts-ignore
            if (window.scribd_doc && typeof window.scribd_doc.page_count === "number") {
              // @ts-ignore
              return window.scribd_doc.page_count;
            }
            const pageIndicator = document.querySelector(
              ".page_number, .page_count, .total_pages"
            );
            if (pageIndicator?.textContent) {
              const match = pageIndicator.textContent.match(/(?:of|\/)\s*(\d+)/i);
              if (match) return parseInt(match[1], 10);
            }
            const outerWrappers = document.querySelectorAll(
              "[id^='outer_page_'], .outer_page"
            );
            if (outerWrappers.length > 0) return outerWrappers.length;
            return 30;
          });

          sendEvent("init", { totalPages: actualTotalPages });

          const capturedPages = new Set<number>();

          for (let pageNum = 1; pageNum <= actualTotalPages; pageNum++) {
            if (capturedPages.has(pageNum)) continue;

            sendEvent("status", {
              message: `Capturing page ${pageNum} of ${actualTotalPages}...`,
              current: pageNum,
              total: actualTotalPages,
            });

            // Scroll directly to page
            await page.evaluate((targetNum) => {
              const el =
                document.getElementById(`outer_page_${targetNum}`) ||
                document.getElementById(`page_${targetNum}`) ||
                document.querySelector(`[data-page="${targetNum}"]`) ||
                document.querySelector(`.outer_page:nth-of-type(${targetNum})`);

              if (el) {
                (el as HTMLElement).style.filter = "none";
                (el as HTMLElement).style.opacity = "1";
                (el as HTMLElement).style.display = "block";
                el.scrollIntoView({ behavior: "instant", block: "center" });
                return true;
              }
              window.scrollBy(0, 800);
              return false;
            }, pageNum);

            await new Promise((r) => setTimeout(r, 350));

            // Select outer page element
            const elHandle = await page.$(
              `#outer_page_${pageNum}, [data-page="${pageNum}"], #page_${pageNum}`
            );

            if (elHandle) {
              try {
                const boundingBox = await elHandle.boundingBox();

                if (
                  boundingBox &&
                  boundingBox.width > 50 &&
                  boundingBox.height > 50
                ) {
                  const imageBuffer = (await elHandle.screenshot({
                    type: "jpeg",
                    quality: 80,
                  })) as Buffer;

                  const pageData = {
                    pageNumber: pageNum,
                    image: `data:image/jpeg;base64,${imageBuffer.toString("base64")}`,
                    width: Math.round(boundingBox.width),
                    height: Math.round(boundingBox.height),
                  };

                  capturedPages.add(pageNum);
                  sendEvent("page", pageData);
                }
              } catch (err) {
                console.warn(`Failed to capture page ${pageNum}:`, err);
              }
            }
          }

          sendEvent("complete", { total: capturedPages.size });
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