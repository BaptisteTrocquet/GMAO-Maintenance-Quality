# Integration examples

All examples use synthetic placeholders only. Replace the token identifiers/secrets with least-privilege scoped integration tokens created for the target site and origin.

## Static HTML

- `maintenance-request-iframe.html` — direct secured maintenance-request iframe
- `widget-loader.html` — `embed.js` script-loader with validated theme tokens

## React

`react/OpenGmaoAssetCard.tsx` demonstrates a reusable React iframe component. The scoped browser secret is placed in the iframe URL fragment, not the query string, and the frame uses `strict-origin` referrer policy plus sandboxing.

## Next.js

`nextjs/OpenGmaoKpiPage.tsx` demonstrates a server component using `@opengmao/sdk` semantics. The scoped `kpi:read` credential is loaded from server environment variables and is never rendered into the returned HTML.

Expected server environment variables:

```text
GMAO_BASE_URL=https://gmao.example.test
GMAO_KPI_TOKEN_ID=<non-secret token id>
GMAO_KPI_TOKEN=<scoped secret>
```

## CI

`npm run examples:check` executes the React/Next examples and validates the static integration contracts. GitHub CI runs this as an explicit `Run integration examples` step in addition to normal unit tests.
