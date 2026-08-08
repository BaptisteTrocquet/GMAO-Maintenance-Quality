"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  GLOBAL_SEARCH_MIN_LENGTH,
  type GlobalSearchKind,
  type GlobalSearchResult,
} from "@/lib/search/global-search";

type Props = {
  organizationId: string;
  siteId: string;
};

type SearchResponse = {
  data?: {
    query: string;
    results: GlobalSearchResult[];
  };
  error?: {
    message?: string;
  };
};

const KIND_LABEL: Record<GlobalSearchKind, string> = {
  ASSET: "Assets",
  WORK_ORDER: "Work orders",
  DOCUMENT: "Documents",
  PART: "Parts",
  QUALITY: "Quality",
};

const KIND_ORDER: GlobalSearchKind[] = ["ASSET", "WORK_ORDER", "DOCUMENT", "QUALITY", "PART"];

export default function GlobalSearchClient({ organizationId, siteId }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get("q")?.trim() ?? "";
  const [input, setInput] = useState(urlQuery);
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setInput(urlQuery), [urlQuery]);

  useEffect(() => {
    if (!organizationId || !siteId || urlQuery.length < GLOBAL_SEARCH_MIN_LENGTH) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ organizationId, siteId, q: urlQuery });
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

    return () => controller.abort();
  }, [organizationId, siteId, urlQuery]);

  const grouped = useMemo(() => {
    const map = new Map<GlobalSearchKind, GlobalSearchResult[]>();
    for (const result of results) {
      const current = map.get(result.kind) ?? [];
      current.push(result);
      map.set(result.kind, current);
    }
    return map;
  }, [results]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = input.trim();
    if (query.length < GLOBAL_SEARCH_MIN_LENGTH) {
      setError(`Enter at least ${GLOBAL_SEARCH_MIN_LENGTH} characters.`);
      return;
    }
    router.push(`/search?q=${encodeURIComponent(query)}`);
  }

  if (!organizationId || !siteId) {
    return (
      <section className="card">
        <p>Select an organization and site to search operational data.</p>
      </section>
    );
  }

  return (
    <>
      <form className="card" role="search" onSubmit={submit} style={{ display: "grid", gap: 10 }}>
        <label htmlFor="global-search-input"><strong>Search this site</strong></label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            id="global-search-input"
            name="q"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Asset code, WO number, document, quality event, spare part…"
            autoComplete="off"
            style={{ flex: "1 1 360px" }}
          />
          <button type="submit" disabled={loading}>{loading ? "Searching…" : "Search"}</button>
        </div>
        <div className="muted">
          Results are limited per category and filtered by your current role and selected site.
        </div>
      </form>

      {error ? <section className="card section" role="alert">{error}</section> : null}

      {!urlQuery ? (
        <section className="card section">
          <p className="muted">Enter at least two characters to search across operational records.</p>
        </section>
      ) : null}

      {urlQuery && !loading && !error && results.length === 0 ? (
        <section className="card section" role="status">
          No results for <strong>{urlQuery}</strong> in the categories you can access.
        </section>
      ) : null}

      {KIND_ORDER.map((kind) => {
        const items = grouped.get(kind) ?? [];
        if (!items.length) return null;
        return (
          <section className="card section" key={kind} aria-labelledby={`search-${kind}`}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <h2 id={`search-${kind}`} style={{ margin: 0 }}>{KIND_LABEL[kind]}</h2>
              <span className="badge">{items.length}</span>
            </div>
            <div className="stack-list" style={{ marginTop: 12 }}>
              {items.map((item) => (
                <article key={`${item.kind}:${item.id}`} style={{ display: "grid", gap: 4 }}>
                  <Link className="table-link" href={item.href}><strong>{item.label}</strong></Link>
                  <div>{item.description}</div>
                  <div className="muted">{item.meta}</div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
