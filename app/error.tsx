"use client";

import { useEffect } from "react";

import { logger } from "@/lib/logger";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error("application_route_error", {
      component: "app-error-boundary",
      digest: error.digest ?? null,
    });
  }, [error.digest]);

  return (
    <div className="card">
      <h1>Something went wrong</h1>
      <p className="muted">
        The application could not complete this request. You can retry without losing the rest of your session.
      </p>
      <button className="button" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
