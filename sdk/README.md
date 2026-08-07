# @opengmao/sdk

Dependency-free TypeScript client for the OpenGMAO versioned public API.

The client authenticates with the same least-privilege scoped integration token used by the public API. It never requires an administrator session or secret.

## Usage

```ts
import { OpenGmaoClient } from "@opengmao/sdk";

const gmao = new OpenGmaoClient({
  baseUrl: "https://gmao.example.test",
  tokenId: process.env.GMAO_TOKEN_ID!,
  token: process.env.GMAO_TOKEN!,
});

const request = await gmao.maintenanceRequests.create({
  title: "Unexpected vibration",
  assetCode: "ASSET-100",
});

const status = await gmao.maintenanceRequests.status(request.trackingId);
const asset = await gmao.assets.get("ASSET-100");
const kpis = await gmao.kpis.get();
const controlledDocument = await gmao.documents.download("SOP-100");
```

`documents.download()` returns the integrity-verified controlled file as `Uint8Array` together with revision, effective-date and SHA-256 traceability metadata.

## Browser use

For a browser token configured in `EMBEDDED` mode, the browser sends its `Origin` header automatically and the API validates it against the token's exact allowed-origin list. Do not put administrator credentials in browser code.

For turnkey browser UI, prefer `/embed.js` and the iframe widgets; the SDK is intended for custom headless integrations.

## Errors

Non-2xx responses throw `OpenGmaoApiError` with:

- `status` — HTTP status
- `code` — stable API error code where available
- `message` — safe server message
- `details` — optional validation details

## Capabilities

The token must carry the capability needed by each operation:

- request creation → `maintenance:request:create`
- request status → `maintenance:request:status`
- asset card → `asset:read`
- controlled document → `document:read`
- KPI card → `kpi:read`
