"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  GLOBAL_SEARCH_MIN_LENGTH,
  type GlobalSearchResult,
} from "@/lib/search/global-search";
import {
  buildCommandPaletteItems,
  moveCommandPaletteIndex,
} from "@/lib/search/command-palette";

type Props = {
  organizationId: string;
  siteId: string;
};

type SearchResponse = {
  data?: {
    query: string;
    results: GlobalSearchResult[];
  };
  error?: { message?: string };
};

export default function CommandPalette({ organizationId, siteId }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo(
    () => buildCommandPaletteItems({ query, results }),
    [query, results],
  );

  useEffect(() => {
    function globalShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", globalShortcut);
    return () => window.removeEventListener("keydown", globalShortcut);
  }, []);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const normalized = query.trim().replace(/\s+/g, " ");
    if (
      normalized.length < GLOBAL_SEARCH_MIN_LENGTH ||
      !organizationId ||
      !siteId
    ) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        organizationId,
        siteId,
        q: normalized,
      });
      void fetch(`/api/search?${params.toString()}`, { signal: controller.signal })
        .then(async (response) => {
          const body = (await response.json()) as SearchResponse;
          if (!response.ok) throw new Error(body.error?.message ?? "Search failed");
          setResults(body.data?.results ?? []);
        })
        .catch((searchError: unknown) => {
          if (searchError instanceof DOMException && searchError.name === "AbortError") return;
          setResults([]);
          setError(searchError instanceof Error ? searchError.message : "Search failed");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, organizationId, query, siteId]);

  useEffect(() => {
    setActiveIndex((current) => {
      if (!items.length) return -1;
      return current < 0 || current >= items.length ? 0 : current;
    });
  }, [items]);

  function close() {
    setOpen(false);
    setQuery("");
    setResults([]);
    setError(null);
    setActiveIndex(0);
  }

  function navigate(href: string) {
    close();
    router.push(href);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => moveCommandPaletteIndex(current, 1, items.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => moveCommandPaletteIndex(current, -1, items.length));
      return;
    }
    if (event.key === "Enter" && activeIndex >= 0 && items[activeIndex]) {
      event.preventDefault();
      navigate(items[activeIndex].href);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          width: "100%",
          marginTop: 12,
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span>Command menu</span>
        <kbd>⌘K</kbd>
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
            background: "rgba(15, 23, 42, 0.48)",
            display: "grid",
            placeItems: "start center",
            padding: "min(14vh, 120px) 16px 24px",
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-palette-title"
            style={{
              width: "min(720px, 100%)",
              maxHeight: "min(70vh, 680px)",
              overflow: "hidden",
              borderRadius: 14,
              background: "var(--panel, white)",
              border: "1px solid #dbe2ea",
              boxShadow: "0 24px 80px rgba(15, 23, 42, 0.28)",
              display: "grid",
              gridTemplateRows: "auto minmax(0, 1fr) auto",
            }}
          >
            <div style={{ padding: 14, borderBottom: "1px solid #e5e7eb" }}>
              <div id="command-palette-title" className="muted" style={{ marginBottom: 7 }}>
                Command palette · Ctrl/Cmd+K
              </div>
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Search assets, work orders, documents, parts, quality…"
                autoComplete="off"
                aria-label="Command palette search"
                aria-controls="command-palette-results"
                aria-activedescendant={
                  activeIndex >= 0 && items[activeIndex]
                    ? `command-item-${items[activeIndex].id}`
                    : undefined
                }
                style={{ width: "100%", fontSize: 16 }}
              />
            </div>

            <div
              id="command-palette-results"
              role="listbox"
              aria-label="Command palette results"
              style={{ overflowY: "auto", padding: 8 }}
            >
              {items.map((item, index) => (
                <button
                  key={item.id}
                  id={`command-item-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => navigate(item.href)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    display: "grid",
                    gap: 3,
                    padding: "10px 12px",
                    marginBottom: 4,
                    borderRadius: 9,
                    border: index === activeIndex ? "1px solid currentColor" : "1px solid transparent",
                    background: index === activeIndex ? "rgba(148, 163, 184, 0.15)" : "transparent",
                  }}
                >
                  <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>{item.label}</strong>
                    <span className="badge">{item.group === "SEARCH" ? "Result" : "Go to"}</span>
                  </span>
                  <span>{item.description}</span>
                  {item.meta ? <span className="muted">{item.meta}</span> : null}
                </button>
              ))}

              {!items.length && !loading ? (
                <div className="muted" role="status" style={{ padding: 16 }}>
                  No matching commands or permitted records.
                </div>
              ) : null}
            </div>

            <div
              className="muted"
              style={{
                padding: "10px 14px",
                borderTop: "1px solid #e5e7eb",
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <span>{loading ? "Searching…" : error ?? "↑↓ select · Enter open · Esc close"}</span>
              {!organizationId || !siteId ? <span>Select a site for record search.</span> : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
