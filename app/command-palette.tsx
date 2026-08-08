"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  COMMAND_PALETTE_QUICK_ACTIONS,
  nextCommandIndex,
  searchResultToCommand,
  type CommandPaletteItem,
} from "@/lib/search/command-palette";
import {
  GLOBAL_SEARCH_MIN_LENGTH,
  type GlobalSearchResult,
} from "@/lib/search/global-search";

type Props = {
  organizationId: string;
  siteId: string;
};

type SearchResponse = {
  data?: { results: GlobalSearchResult[] };
  error?: { message?: string };
};

export default function CommandPalette({ organizationId, siteId }: Props) {
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const close = useCallback(({ restoreFocus = true }: { restoreFocus?: boolean } = {}) => {
    setOpen(false);
    setQuery("");
    setResults([]);
    setError(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    function globalKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) close();
        else setOpen(true);
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", globalKeyDown);
    return () => window.removeEventListener("keydown", globalKeyDown);
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    const normalized = query.trim();
    if (!open || normalized.length < GLOBAL_SEARCH_MIN_LENGTH) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (!organizationId || !siteId) {
      setResults([]);
      setLoading(false);
      setError("Select an organization and site to search records.");
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ organizationId, siteId, q: normalized });
      setLoading(true);
      setError(null);
      void fetch(`/api/search?${params.toString()}`, { signal: controller.signal })
        .then(async (response) => {
          const body = (await response.json()) as SearchResponse;
          if (!response.ok) throw new Error(body.error?.message ?? "Search failed");
          setResults(body.data?.results ?? []);
        })
        .catch((fetchError: unknown) => {
          if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
          setResults([]);
          setError(fetchError instanceof Error ? fetchError.message : "Search failed");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, organizationId, siteId, query]);

  const items = useMemo<CommandPaletteItem[]>(() => {
    if (query.trim().length < GLOBAL_SEARCH_MIN_LENGTH) return COMMAND_PALETTE_QUICK_ACTIONS;
    return results.map(searchResultToCommand);
  }, [query, results]);

  useEffect(() => {
    setActiveIndex(items.length ? 0 : -1);
  }, [items]);

  function navigate(item: CommandPaletteItem) {
    close({ restoreFocus: false });
    router.push(item.href);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => nextCommandIndex({ current, direction: 1, total: items.length }));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => nextCommandIndex({ current, direction: -1, total: items.length }));
    } else if (event.key === "Home" && items.length) {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End" && items.length) {
      event.preventDefault();
      setActiveIndex(items.length - 1);
    } else if (event.key === "Enter") {
      const item = items[activeIndex];
      if (!item) return;
      event.preventDefault();
      navigate(item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="Control+K Meta+K"
        style={{ margin: "12px 16px 0", width: "calc(100% - 32px)", textAlign: "left" }}
      >
        Commands <span aria-hidden="true">⌘K</span>
      </button>

      {open ? (
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0, 0, 0, 0.36)",
            display: "grid",
            alignItems: "start",
            justifyItems: "center",
            padding: "10vh 16px 16px",
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-palette-title"
            style={{ width: "min(720px, 100%)", maxHeight: "72vh", overflow: "auto" }}
            className="card"
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <h2 id="command-palette-title" style={{ margin: 0 }}>Command palette</h2>
              <button type="button" onClick={() => close()} aria-label="Close command palette">Esc</button>
            </div>

            <label htmlFor="command-palette-input" className="muted" style={{ display: "block", marginTop: 12 }}>
              Search permitted records or choose an action
            </label>
            <input
              ref={inputRef}
              id="command-palette-input"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls="command-palette-results"
              aria-activedescendant={activeIndex >= 0 ? `command-item-${activeIndex}` : undefined}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              autoComplete="off"
              placeholder="Type at least two characters…"
              style={{ width: "100%", marginTop: 6 }}
            />

            <div className="muted" style={{ marginTop: 8, fontSize: 12 }} aria-live="polite">
              {loading
                ? "Searching…"
                : query.trim().length < GLOBAL_SEARCH_MIN_LENGTH
                  ? "Quick actions · use ↑/↓ and Enter"
                  : `${items.length} result${items.length === 1 ? "" : "s"}`}
            </div>
            {error ? <div role="alert" style={{ marginTop: 8 }}>{error}</div> : null}

            <div
              id="command-palette-results"
              role="listbox"
              aria-label="Command results"
              style={{ display: "grid", gap: 6, marginTop: 12 }}
            >
              {items.map((item, index) => (
                <button
                  id={`command-item-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  key={item.key}
                  type="button"
                  onClick={() => navigate(item)}
                  onMouseEnter={() => setActiveIndex(index)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 8,
                    padding: 10,
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                    outline: index === activeIndex ? "2px solid currentColor" : undefined,
                    outlineOffset: -2,
                    textAlign: "left",
                    background: "transparent",
                    color: "inherit",
                    width: "100%",
                  }}
                >
                  <span style={{ display: "grid", gap: 3 }}>
                    <strong>{item.label}</strong>
                    <span className="muted" style={{ fontSize: 12 }}>{item.description}</span>
                  </span>
                  <span className="badge">{item.badge}</span>
                </button>
              ))}
              {!loading && !error && query.trim().length >= GLOBAL_SEARCH_MIN_LENGTH && items.length === 0 ? (
                <div className="muted">No permitted results in the selected site.</div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
