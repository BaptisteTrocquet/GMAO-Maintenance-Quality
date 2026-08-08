"use client";

import { useEffect } from "react";

import { logger } from "@/lib/logger";

export default function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const register = async () => {
      try {
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      } catch {
        // Registration failure must not break the authenticated application shell.
        logger.warn("pwa_service_worker_registration_failed", {
          component: "pwa-register",
        });
      }
    };

    if (document.readyState === "complete") {
      void register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
