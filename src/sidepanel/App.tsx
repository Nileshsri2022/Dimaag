import { Settings } from "lucide-react";
import CaptureView from "./CaptureView";

/**
 * Side panel (Task 14 scope): the approved Capture design's quiet header
 * (wordmark + Capture·Chat·Browse text tabs + settings gear) and footer, with
 * the Capture view as content. Chat and Browse arrive in Tasks 15–16 — their
 * tab buttons are rendered inert until their views exist.
 */
export default function App() {
  return (
    <main className="flex min-h-screen flex-col bg-background font-sans text-foreground antialiased">
      {/* Quiet extension header */}
      <header className="sticky top-0 z-20 border-b border-[#e7e2d8] bg-background/95 px-4 pb-2.5 pt-3.5 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3.5">
            <span className="text-[18px] font-medium leading-[28px] tracking-tight">Dimaag</span>
            <nav
              aria-label="Extension Navigation"
              className="flex items-center text-[13px] font-medium leading-none text-[#645d58]"
            >
              {/* Active "Capture" with the design's 2px indicator */}
              <div className="relative py-1">
                <span className="font-semibold text-primary">Capture</span>
                <div className="absolute -bottom-2.5 left-0 right-0 h-[2px] rounded-full bg-primary" />
              </div>
              <span className="mx-1.5 select-none text-[11px] text-[#a8a29e]">·</span>
              {/* Inert until Tasks 15/16 wire the views */}
              <button type="button" disabled className="py-1 text-[#a8a29e] cursor-not-allowed">
                Chat
              </button>
              <span className="mx-1.5 select-none text-[11px] text-[#a8a29e]">·</span>
              <button type="button" disabled className="py-1 text-[#a8a29e] cursor-not-allowed">
                Browse
              </button>
            </nav>
          </div>
          <button
            type="button"
            aria-label="Settings"
            onClick={() => void chrome.runtime.openOptionsPage().catch(() => {})}
            className="flex items-center justify-center rounded-[6px] p-1.5 text-[#645d58] transition-colors hover:bg-[#f4f4f0] hover:text-foreground"
          >
            <Settings aria-hidden className="size-[19px]" />
          </button>
        </div>
      </header>

      {/* Content workspace */}
      <div className="flex-1 overflow-y-auto">
        <CaptureView />
      </div>

      {/* Quiet footnote */}
      <footer className="mt-auto border-t border-[#e7e2d8] bg-background px-4 py-3">
        <div className="flex items-center justify-between text-[11px] tracking-[0.04em] text-[#a8a29e]">
          <span>Local storage via IndexedDB</span>
          <span className="font-mono text-[10px]">Vault #01</span>
        </div>
      </footer>
    </main>
  );
}
