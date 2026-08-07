# Product Vision

## Mission
Build an open-source Maintenance + Quality + Document Management platform that is useful from day one, deployable anywhere, and easy to integrate into an existing website or information system.

## Product principles

1. **Standalone first** — a small organization can run the complete product with Docker.
2. **API first** — every important business capability must be usable through a documented API.
3. **Embeddable by design** — selected experiences can be embedded into an existing website without rebuilding the host site.
4. **Modular** — Maintenance, Documents, Quality, Inventory and AI should remain separable domains.
5. **Open source** — no private customer data, hidden business logic or proprietary dependency is required to run the core product.
6. **Auditability** — important state changes must be traceable.
7. **Progressive complexity** — useful for a 20-person workshop but scalable to multi-site organizations.
8. **AI-ready, not AI-dependent** — the product works without an LLM; AI is an optional acceleration layer.

## Three consumption modes

### 1. Full application
A complete web application for maintenance, quality and document control.

### 2. Embedded widgets
Examples:
- maintenance request form
- asset status card
- work-order tracker
- controlled-document viewer
- KPI card

Preferred integration path: one script tag or iframe with a scoped embed token.

### 3. Headless API / SDK
External websites, portals, mobile apps and internal tools can use the same domain APIs through REST/OpenAPI and later a TypeScript SDK.

## Competitive direction
The project should compete with established CMMS platforms on functional breadth, while differentiating through modern UX, deployability, document control, quality workflows, open APIs and embeddability.
