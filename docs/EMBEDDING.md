# Embedding Strategy

A central goal is to let an organization integrate selected GMAO capabilities into an existing website with minimal development.

## Supported integration levels

### Level A — Link / SSO
The simplest integration: link from the existing site to the full application. Later SSO can remove the second login.

### Level B — iframe widgets
Fastest general-purpose embed. Example:

```html
<iframe
  src="https://gmao.example.com/embed/work-request?token=SCOPED_TOKEN"
  width="100%"
  height="720"
  loading="lazy"
></iframe>
```

The token must be short-lived or revocable and scoped to a specific capability/site.

### Level C — script-loader widgets
Target developer experience:

```html
<div id="gmao-maintenance-request"></div>
<script
  src="https://gmao.example.com/embed.js"
  data-widget="maintenance-request"
  data-target="#gmao-maintenance-request"
  data-token="SCOPED_TOKEN">
</script>
```

This allows theme adaptation and a more native visual integration.

### Level D — Headless API / SDK
For custom portals:

```ts
const gmao = new GmaoClient({ baseUrl, apiKey });
await gmao.workRequests.create({ assetCode, title, description });
```

## First embeddable use cases

1. Public maintenance request form
2. Request status tracker
3. Asset information card
4. Controlled document viewer
5. KPI card

## Security requirements

- never expose administrator credentials to browser widgets
- scoped embed tokens
- expiration and revocation
- explicit allowed origins
- rate limiting
- CSRF strategy where cookies are used
- CSP/frame-ancestors policy configurable per tenant
- all input validated server-side
- all sensitive fields hidden by default
- tenant/site boundaries enforced server-side

## Architectural rule
Embedded UI must call the same service/domain layer as the full application. We do not maintain a second business logic implementation for widgets.
