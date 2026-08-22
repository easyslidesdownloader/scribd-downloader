"use client";

import { useState } from "react";
import jsPDF from "jspdf";

type ScribdPage = {
  pageNumber: number;
  image: string;
  width: number;
  height: number;
};

export default function Home() {
  const [url, setUrl] = useState("https://www.scribd.com/document/823002330/panel-free-Fire-code");
  const [pages, setPages] = useState<ScribdPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [error, setError] = useState("");

  async function loadScribd() {
    if (!url.trim()) {
      setError("Please enter a valid Scribd URL.");
      return;
    }

    setLoading(true);
    setIsComplete(false);
    setError("");
    setPages([]);
    setTotalPages(null);
    setStatusMessage("Connecting to server...");

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!response.ok || !response.body) {
        throw new Error("Failed to connect to the analysis stream.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const rawEvent of events) {
          if (!rawEvent.trim()) continue;

          const lines = rawEvent.split("\n");
          let eventType = "message";
          let dataStr = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.replace("event: ", "").trim();
            } else if (line.startsWith("data: ")) {
              dataStr = line.replace("data: ", "").trim();
            }
          }

          if (!dataStr) continue;

          try {
            const parsed = JSON.parse(dataStr);

            if (eventType === "init") {
              setTotalPages(parsed.totalPages);
            } else if (eventType === "status") {
              setStatusMessage(parsed.message);
            } else if (eventType === "page") {
              setPages((prev) => {
                // Avoid duplicate additions
                if (prev.some((p) => p.pageNumber === parsed.pageNumber)) return prev;
                const nextList = [...prev, parsed];
                return nextList.sort((a, b) => a.pageNumber - b.pageNumber);
              });
            } else if (eventType === "complete") {
              setIsComplete(true);
              setStatusMessage(`All ${parsed.total} pages extracted successfully!`);
            } else if (eventType === "error") {
              throw new Error(parsed.message);
            }
          } catch (e) {
            console.error("Parse error on chunk:", e);
          }
        }
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Something went wrong during extraction.");
    } finally {
      setLoading(false);
    }
  }

  async function downloadAsPdf() {
    if (pages.length === 0) return;
    setDownloadingPdf(true);

    try {
      const firstPage = pages[0];
      const orientation = firstPage.width > firstPage.height ? "landscape" : "portrait";

      const pdf = new jsPDF({
        orientation,
        unit: "px",
        format: [firstPage.width, firstPage.height],
      });

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        if (i > 0) {
          pdf.addPage([page.width, page.height], page.width > page.height ? "landscape" : "portrait");
        }
        pdf.addImage(page.image, "JPEG", 0, 0, page.width, page.height);
      }

      pdf.save("scribd-document.pdf");
    } catch (err) {
      console.error("PDF generation failed:", err);
      alert("Failed to build PDF file.");
    } finally {
      setDownloadingPdf(false);
    }
  }

  // Calculate real-time percentage
  const progressPercent =
    totalPages && totalPages > 0 ? Math.min(100, Math.round((pages.length / totalPages) * 100)) : 0;

  return (
    <main className="min-h-screen bg-slate-100 py-10 px-4">
      <div className="max-w-4xl mx-auto">
        
        {/* HEADER */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight">
            Scribd Document Downloader & Streamer
          </h1>
          <p className="text-slate-600 mt-2">
            Watch pages stream in live in real time and download the complete PDF.
          </p>
        </div>

        {/* INPUT FORM */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 mb-6">
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && loadScribd()}
              placeholder="https://www.scribd.com/document/..."
              disabled={loading}
              className="flex-1 px-4 py-3 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-50"
            />

            <button
              onClick={loadScribd}
              disabled={loading}
              className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-400 text-white font-semibold rounded-lg text-sm transition flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Streaming...</span>
                </>
              ) : (
                "Load Document"
              )}
            </button>
          </div>

          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
              {error}
            </div>
          )}
        </div>

        {/* REAL-TIME PROGRESS BAR & CONTROLS */}
        {(loading || pages.length > 0) && (
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm mb-6">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="font-semibold text-slate-800 text-sm">
                  {totalPages ? `Fetched ${pages.length} of ${totalPages} Pages` : `Fetched ${pages.length} Pages`}
                </span>
                <p className="text-xs text-slate-500 mt-0.5">{statusMessage}</p>
              </div>

              {/* DOWNLOAD BUTTON: Active only when complete or at least 1 page exists */}
              <button
                onClick={downloadAsPdf}
                disabled={downloadingPdf || pages.length === 0 || loading}
                className={`px-5 py-2.5 rounded-lg text-sm font-semibold transition shadow-sm ${
                  isComplete || (!loading && pages.length > 0)
                    ? "bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                    : "bg-slate-200 text-slate-400 cursor-not-allowed"
                }`}
              >
                {downloadingPdf
                  ? "Compiling PDF..."
                  : isComplete
                  ? "📥 Download Complete PDF"
                  : loading
                  ? `Capturing (${pages.length}/${totalPages || "..."})`
                  : "📥 Download PDF"}
              </button>
            </div>

            {/* PROGRESS BAR */}
            {totalPages && (
              <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden border border-slate-200">
                <div
                  className="bg-emerald-500 h-full transition-all duration-300 ease-out"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* STREAMING PAGE GRID WITH FADE-IN */}
        <div className="space-y-6">
          {pages.map((page) => (
            <div
              key={`page-${page.pageNumber}`}
              className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all duration-500 animate-fadeIn"
            >
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs font-semibold text-slate-600">
                <span>Page {page.pageNumber}</span>
                <span className="text-slate-400">{page.width} × {page.height}px</span>
              </div>
              <div className="p-3 flex justify-center bg-slate-200">
                <img
                  src={page.image}
                  alt={`Page ${page.pageNumber}`}
                  width={page.width}
                  height={page.height}
                  className="max-w-full h-auto shadow-md rounded"
                />
              </div>
            </div>
          ))}
        </div>

      </div>
    </main>
  );
}