"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PRIMARY_NAVIGATION } from "./navigation-items";

function matchesPath(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function MobileNavigation() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const activeHref = useMemo(() => {
    return [...PRIMARY_NAVIGATION]
      .filter((item) => matchesPath(pathname, item.href))
      .sort((left, right) => right.href.length - left.href.length)[0]?.href;
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const drawer = drawerRef.current;
    const focusable = drawer?.querySelectorAll<HTMLElement>('button, a[href]');
    focusable?.[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;

      const elements = [...drawerRef.current.querySelectorAll<HTMLElement>('button, a[href]')].filter(
        (element) => !element.hasAttribute("disabled") && element.tabIndex !== -1,
      );
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  function close({ restoreFocus = true } = {}) {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  return (
    <>
      <header className="mobile-header">
        <Link className="mobile-brand" href="/" aria-label="OpenGMAO dashboard">
          OpenGMAO
        </Link>
        <button
          ref={triggerRef}
          className="mobile-menu-button"
          type="button"
          aria-label="Open navigation"
          aria-controls="mobile-navigation-drawer"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <span aria-hidden="true">☰</span>
          <span>Menu</span>
        </button>
      </header>

      {open ? (
        <div className="mobile-nav-layer">
          <button
            className="mobile-nav-backdrop"
            type="button"
            aria-label="Close navigation"
            onClick={() => close()}
          />
          <div
            ref={drawerRef}
            id="mobile-navigation-drawer"
            className="mobile-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Mobile navigation"
          >
            <div className="mobile-nav-heading">
              <strong>Navigate</strong>
              <button
                className="mobile-nav-close"
                type="button"
                aria-label="Close navigation"
                onClick={() => close()}
              >
                ×
              </button>
            </div>
            <nav className="mobile-nav-links" aria-label="Primary mobile navigation">
              {PRIMARY_NAVIGATION.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={activeHref === item.href ? "page" : undefined}
                  onClick={() => close({ restoreFocus: false })}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      ) : null}
    </>
  );
}
