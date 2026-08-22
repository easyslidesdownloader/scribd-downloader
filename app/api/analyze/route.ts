import chromium from "@sparticuz/chromium";
import { chromium as playwrightChromium } from "playwright-core";
import { extractScribdDocId, getScribdEmbedUrl } from "@/lib/scribd";

export const maxDuration = 60; // Max allowed execution duration
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

          sendEvent("status", { message: "Launching browser and connecting..." });

          if (process.env.NODE_ENV === "production") {
            // Configure sparticuz for Vercel/AWS Lambda environment
            chromium.setGraphicsMode = false;

            const executablePath = await chromium.executablePath();

            browser = await playwrightChromium.launch({
              args: [
                ...chromium.args,
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--disable-setuid-sandbox",
                "--no-sandbox",
                "--single-process",
                "--no-zygote",
              ],
              executablePath,
              headless: true,
            });
          } else {
            // Local dev mode
            browser = await playwrightChromium.launch({
              headless: true,
              args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-web-security",
              ],
            });
          }

          const context = await browser.newContext({
            viewport: { width: 1200, height: 1600 },
            deviceScaleFactor: 1.2,
            userAgent:
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          });

          const page = await context.newPage();

          sendEvent("status", { message: "Loading document structure..." });

          await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });

          try {
            await page.waitForSelector(".outer_page, .newpage, [id^='outer_page_']", {
              timeout: 15000,
            });
          } catch {
            // continue
          }

          // Un-blur pages & hide promo overlays
          await page.addStyleTag({
            content: `
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
            `,
          });

          // 1. Determine total pages
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

          // 2. Stream pages one by one as they are captured
          for (let pageNum = 1; pageNum <= actualTotalPages; pageNum++) {
            if (capturedPages.has(pageNum)) continue;

            sendEvent("status", {
              message: `Rendering page ${pageNum} of ${actualTotalPages}...`,
              current: pageNum,
              total: actualTotalPages,
            });

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

            await page.waitForTimeout(300);

            let pageLocator = page.locator(`#outer_page_${pageNum}`);
            if ((await pageLocator.count()) === 0) {
              pageLocator = page.locator(`[data-page="${pageNum}"]`);
            }
            if ((await pageLocator.count()) === 0) {
              pageLocator = page.locator(`#page_${pageNum}`);
            }

            if ((await pageLocator.count()) > 0) {
              try {
                const target = pageLocator.first();
                await target.scrollIntoViewIfNeeded();
                await page.waitForTimeout(100);

                const boundingBox = await target.boundingBox();

                if (
                  boundingBox &&
                  boundingBox.width > 50 &&
                  boundingBox.height > 50
                ) {
                  const imageBuffer = await target.screenshot({
                    type: "jpeg",
                    quality: 80,
                    animations: "disabled",
                  });

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