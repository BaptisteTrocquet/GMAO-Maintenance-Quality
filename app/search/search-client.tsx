"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type SearchResult = {
  kind: "WORK_ORDER" | "ASSET" | "DOCUMENT" | "PART";
  id: string;
  code: string;
  title: string;
  detail: string | null;
  href: string;
};

type SearchResponse = {
  query: string;
  results: SearchResult[];
  counts: { workOrders: number; assets: number; documents: number; parts: number };
};

const KIND_LABELS: Record<SearchResult["kind"], string> = {
  WORK_ORDER: "Work orders",
  ASSET: "Assets",
  DOCUMENT: "Documents",
  PART: "Parts",
};

export default function GlobalSearchClient({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get("q") ?? "";
  const [input, setInput] = useState(urlQuery);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInput(urlQuery);
    if (!organizationId || !siteId || urlQuery.trim().length < 2) {
      setData(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setBusy(true);
    setError(null);
    void fetch(
      `/api/search?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}&q=${encodeURIComponent(urlQuery.trim())}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const body = (await response.json()) as {
          data?: SearchResponse;
          error?: { message?: string };
        };
        if (!response.ok || !body.data) {
          throw new Error(body.error?.message ?? "Search failed");
        }
        setData(body.data);
      })
      .catch((searchError: unknown) => {
        if (searchError instanceof DOMException && searchError.name === "AbortError") return;
        setError(searchError instanceof Error ? searchError.message : "Search failed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });

    return () => controller.abort();
  }, [organizationId, siteId, urlQuery]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = input.trim();
    if (query.length < 2) {
      setError("Enter at least 2 characters");
      return;
    }
    router.push(`/search?q=${encodeURIComponent(query)}`);
  }

  const grouped = new Map<SearchResult["kind"], SearchResult[]>();
  for (const result of data?.results ?? []) {
    const current = grouped.get(result.kind) ?? [];
    current.push(result);
    grouped.set(result.kind, current);
  }

  return (
    <>
      <form className="card" role="search" onSubmit={submit} style={{ marginBottom: 16 }}>
        <label htmlFor="global-search-input"><strong>Search the current site</strong></label>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <input
            id="global-search-input"
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Work order, asset, document, part…"
            maxLength={100}
            style={{ flex: "1 1 320px" }}
          />
          <button type="submit" disabled={busy || input.trim().length < 2}>
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Results are limited to resources your role can read in the selected organization/site.
        </p>
      </form>

      {error ? <div className="card" role="alert">{error}</div> : null}

      {data && !busy ? (
        data.results.length ? (
          <div className="grid grid-2">
            {(["WORK_ORDER", "ASSET", "DOCUMENT", "PART"] as const).map((kind) => {
              const results = grouped.get(kind) ?? [];
              if (!results.length) return null;
              return (
                <section className="card" key={kind} aria-labelledby={`search-${kind}`}>
                  <h2 id={`search-${kind}`}>{KIND_LABELS[kind]}</h2>
                  <div className="stack-list">
                    {results.map((result) => (
                      <div key={`${kind}-${result.id}`}>
                        <Link className="table-link" href={result.href}>
                          <strong>{result.code}</strong> · {result.title}
                        </Link>
                        {result.detail ? <div className="muted">{result.detail}</div> : null}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <section className="card" role="status">
            No readable results for “{data.query}” in the current site/organization.
          </section>
        )
      ) : null}
    </>
  );
}
