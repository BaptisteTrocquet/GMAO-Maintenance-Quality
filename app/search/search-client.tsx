"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { GlobalSearchResult } from "@/lib/search/global-search";

const KIND_LABELS: Record<GlobalSearchResult["kind"], string> = {
  ASSET: "Asset",
  WORK_ORDER: "Work order",
  DOCUMENT: "Document",
  PART: "Part",
  QUALITY: "Quality",
};

export function GlobalSearchClient({
  organizationId,
  siteId,
  initialQuery,
}: {
  organizationId: string;
  siteId: string;
  initialQuery: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchedQuery, setSearchedQuery] = useState("");

  async function runSearch(value: string) {
    const normalized = value.trim().replace(/\s+/g, " ");
    if (normalized.length < 2) {
      setResults([]);
      setSearchedQuery("");
      setError("Enter at least two characters.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, siteId, q: normalized });
      const response = await fetch(`/api/search?${params.toString()}`, { method: "GET" });
      const payload = (await response.json().catch(() => null)) as
        | { data?: { query?: string; results?: GlobalSearchResult[] }; error?: { message?: string } }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Search failed");
      }
      const acceptedQuery = payload?.data?.query ?? normalized;
      setResults(payload?.data?.results ?? []);
      setSearchedQuery(acceptedQuery);
      const next = new URL(window.location.href);
      next.searchParams.set("q", acceptedQuery);
      window.history.replaceState(null, "", next);
    } catch (caught) {
      setResults([]);
      setError(caught instanceof Error ? caught.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch(query);
  }

  useEffect(() => {
    if (initialQuery.trim().length >= 2) void runSearch(initialQuery);
    // Run only for the server-provided initial query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery, organizationId, siteId]);

  return (
    <>
      <form className="card" onSubmit={submit} role="search">
        <label htmlFor="global-search-input"><strong>Search across OpenGMAO</strong></label>
        <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <input
            id="global-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Asset, WO, document, spare part, quality event…"
            minLength={2}
            maxLength={80}
            autoComplete="off"
            style={{ flex: "1 1 360px", minWidth: 220 }}
          />
          <button type="submit" disabled={loading}>{loading ? "Searching…" : "Search"}</button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Results are limited to the selected site and to domains your role can read.
        </p>
      </form>

      {error ? <p className="card" role="alert">{error}</p> : null}

      {searchedQuery ? (
        <section className="section" aria-live="polite" aria-busy={loading}>
          <div className="header">
            <div>
              <h2 style={{ margin: 0 }}>Results for “{searchedQuery}”</h2>
              <div className="muted">{results.length} result{results.length === 1 ? "" : "s"}</div>
            </div>
          </div>

          {results.length ? (
            <div style={{ display: "grid", gap: 10 }}>
              {results.map((result) => (
                <article className="card" key={`${result.kind}-${result.id}`}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <Link className="table-link" href={result.href}>
                      <strong>{result.label}</strong>
                    </Link>
                    <span className="badge">{KIND_LABELS[result.kind]}</span>
                  </div>
                  <p style={{ marginBottom: 6 }}>{result.description}</p>
                  <div className="muted">{result.meta}</div>
                </article>
              ))}
            </div>
          ) : (
            <div className="card">No matching records in the current authorized scope.</div>
          )}
        </section>
      ) : null}
    </>
  );
}
