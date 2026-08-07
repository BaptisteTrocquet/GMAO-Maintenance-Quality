export const PUBLIC_API_VERSION = "1.3.0";

const tokenIdParameter = {
  name: "tokenId",
  in: "query",
  required: true,
  schema: { type: "string", minLength: 1 },
} as const;

const originParameter = {
  name: "Origin",
  in: "header",
  required: false,
  schema: { type: "string", format: "uri" },
  description: "Required for EMBEDDED tokens and validated against exact allowed origins.",
} as const;

export const publicOpenApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "OpenGMAO Public API",
    version: PUBLIC_API_VERSION,
    description:
      "Versioned public integration API. Browser integrations use scoped tokens; administrator session credentials are never part of this contract.",
  },
  servers: [{ url: "/", description: "Current OpenGMAO deployment" }],
  tags: [
    {
      name: "Public maintenance requests",
      description: "Create and track tenant/site-scoped maintenance requests from public or embedded clients.",
    },
    {
      name: "Public assets",
      description: "Read a minimal site-scoped asset card using an integration token with asset:read capability.",
    },
    {
      name: "Public controlled documents",
      description: "Read only effective, integrity-verified controlled documents applicable to the scoped token site.",
    },
  ],
  paths: {
    "/api/v1/public/maintenance-requests": {
      options: {
        tags: ["Public maintenance requests"],
        summary: "Validate CORS preflight for a scoped request token",
        parameters: [tokenIdParameter, { ...originParameter, required: true }],
        responses: {
          "204": { description: "Origin is allowed for the active token." },
          "400": { description: "tokenId or Origin is missing." },
          "403": { description: "Token is inactive, lacks the required capability, or the origin is not allowed." },
        },
      },
      post: {
        tags: ["Public maintenance requests"],
        summary: "Create a scoped maintenance request",
        description:
          "Requires maintenance:request:create. Creates a REQUESTED, NORMAL-priority CORRECTIVE work order in the site bound to the scoped token. Replays with the same Idempotency-Key return the original work order and trackingId.",
        operationId: "createPublicMaintenanceRequestV1",
        security: [{ scopedPublicRequestToken: [] }],
        parameters: [
          tokenIdParameter,
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 8, maxLength: 200 },
          },
          originParameter,
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PublicMaintenanceRequestInput" },
              example: {
                title: "Abnormal equipment noise",
                description: "Noise noticed during normal operation.",
                assetCode: "ASSET-100",
                requesterName: "External Requester",
                requesterEmail: "requester@example.test",
                requesterRef: "PORTAL-1234",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Maintenance request created.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PublicMaintenanceRequestResult" } } },
          },
          "200": {
            description: "Idempotent replay; original work order and trackingId returned.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PublicMaintenanceRequestResult" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { description: "Scoped site or asset was not found." },
          "409": { description: "Idempotent result is inconsistent or unavailable." },
          "429": { description: "Scoped token exceeded its hourly request limit." },
        },
      },
    },
    "/api/v1/public/request-status": {
      options: {
        tags: ["Public maintenance requests"],
        summary: "Validate CORS preflight for request-status lookup",
        parameters: [tokenIdParameter, { ...originParameter, required: true }],
        responses: {
          "204": { description: "Origin is allowed for the active token." },
          "400": { description: "tokenId or Origin is missing." },
          "403": { description: "Token is inactive, lacks maintenance:request:status, or the origin is not allowed." },
        },
      },
      get: {
        tags: ["Public maintenance requests"],
        summary: "Read the public status of a previously created maintenance request",
        description:
          "Requires maintenance:request:status on the same active scoped token used to create the request plus the opaque trackingId returned by request creation. Only a minimal public status projection is returned.",
        operationId: "getPublicMaintenanceRequestStatusV1",
        security: [{ scopedPublicRequestToken: [] }],
        parameters: [
          tokenIdParameter,
          { name: "trackingId", in: "query", required: true, schema: { type: "string", minLength: 1 } },
          originParameter,
        ],
        responses: {
          "200": {
            description: "Minimal public work-order status.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PublicMaintenanceStatusResult" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { description: "trackingId does not belong to this scoped token." },
          "409": { description: "Tracked work order is no longer available." },
          "429": { description: "Scoped token exceeded its hourly status-lookup limit." },
        },
      },
    },
    "/api/v1/public/assets": {
      options: {
        tags: ["Public assets"],
        summary: "Validate CORS preflight for asset-card lookup",
        parameters: [tokenIdParameter, { ...originParameter, required: true }],
        responses: {
          "204": { description: "Origin is allowed and the active token has asset:read." },
          "400": { description: "tokenId or Origin is missing." },
          "403": { description: "Token is inactive, lacks asset:read, or the origin is not allowed." },
        },
      },
      get: {
        tags: ["Public assets"],
        summary: "Read a minimal public asset card",
        description:
          "Requires asset:read. The asset code is resolved only inside the site bound to the scoped token. Archived assets and sensitive internal fields are not exposed.",
        operationId: "getPublicAssetCardV1",
        security: [{ scopedPublicRequestToken: [] }],
        parameters: [
          tokenIdParameter,
          { name: "assetCode", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 50 } },
          originParameter,
        ],
        responses: {
          "200": {
            description: "Minimal public asset card.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PublicAssetCardResult" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { description: "Asset is not available in the scoped token site." },
          "429": { description: "Scoped token exceeded its hourly asset-card lookup limit." },
        },
      },
    },
    "/api/v1/public/documents": {
      options: {
        tags: ["Public controlled documents"],
        summary: "Validate CORS preflight for controlled-document lookup",
        parameters: [tokenIdParameter, { ...originParameter, required: true }],
        responses: {
          "204": { description: "Origin is allowed and the active token has document:read." },
          "400": { description: "tokenId or Origin is missing." },
          "403": { description: "Token is inactive, lacks document:read, or the origin is not allowed." },
        },
      },
      get: {
        tags: ["Public controlled documents"],
        summary: "Read the effective controlled copy applicable to the token site",
        description:
          "Requires document:read. documentCode must be applicable to at least one non-archived asset in the token site. The server resolves the effective revision at asOf, verifies stored-file SHA-256 integrity, audits issuance and returns only that controlled binary.",
        operationId: "getPublicControlledDocumentV1",
        security: [{ scopedPublicRequestToken: [] }],
        parameters: [
          tokenIdParameter,
          { name: "documentCode", in: "query", required: true, schema: { type: "string", minLength: 1 } },
          { name: "asOf", in: "query", required: false, schema: { type: "string", format: "date-time" } },
          originParameter,
        ],
        responses: {
          "200": {
            description: "Integrity-verified effective controlled file.",
            headers: {
              "X-Controlled-Copy": { schema: { type: "string", const: "true" } },
              "X-Document-Code": { schema: { type: "string" } },
              "X-Document-Revision": { schema: { type: "string" } },
              "X-Document-Effective-At": { schema: { type: "string" } },
              "X-Content-SHA256": { schema: { type: "string", pattern: "^[a-fA-F0-9]{64}$" } },
            },
            content: {
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { description: "Document is not site-applicable or no revision is effective at asOf." },
          "409": { description: "The effective file is unavailable or failed integrity verification." },
          "429": { description: "Scoped token exceeded its hourly controlled-document lookup limit." },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      scopedPublicRequestToken: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "opaque scoped token",
        description:
          "Short-lived/revocable site-scoped token with immutable least-privilege capabilities. The raw secret is returned only when the token is created and is not an administrator credential.",
      },
    },
    schemas: {
      PublicMaintenanceRequestInput: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: ["string", "null"], maxLength: 5000 },
          assetCode: { type: ["string", "null"], minLength: 1, maxLength: 50 },
          requesterName: { type: ["string", "null"], minLength: 1, maxLength: 150 },
          requesterEmail: { type: ["string", "null"], format: "email", maxLength: 320 },
          requesterRef: { type: ["string", "null"], minLength: 1, maxLength: 150 },
        },
      },
      PublicWorkOrderSummary: {
        type: "object",
        required: ["id", "number", "status", "requestedAt"],
        properties: {
          id: { type: "string" },
          number: { type: "string" },
          status: { type: "string", const: "REQUESTED" },
          requestedAt: { type: "string", format: "date-time" },
        },
      },
      PublicMaintenanceRequestResult: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "object",
            required: ["idempotent", "trackingId", "workOrder"],
            properties: {
              idempotent: { type: "boolean" },
              trackingId: { type: "string", description: "Opaque submission identifier used with the same scoped token for status lookup." },
              workOrder: { $ref: "#/components/schemas/PublicWorkOrderSummary" },
            },
          },
        },
      },
      PublicStatusWorkOrder: {
        type: "object",
        required: ["number", "status", "requestedAt", "updatedAt"],
        properties: {
          number: { type: "string" },
          status: { type: "string" },
          requestedAt: { type: "string", format: "date-time" },
          plannedStart: { type: ["string", "null"], format: "date-time" },
          dueAt: { type: ["string", "null"], format: "date-time" },
          startedAt: { type: ["string", "null"], format: "date-time" },
          completedAt: { type: ["string", "null"], format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      PublicMaintenanceStatusResult: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "object",
            required: ["trackingId", "workOrder"],
            properties: {
              trackingId: { type: "string" },
              workOrder: { $ref: "#/components/schemas/PublicStatusWorkOrder" },
            },
          },
        },
      },
      PublicAssetLocation: {
        type: ["object", "null"],
        properties: {
          code: { type: "string" },
          name: { type: "string" },
        },
      },
      PublicAssetCard: {
        type: "object",
        required: ["code", "name", "status", "criticality", "updatedAt"],
        properties: {
          code: { type: "string" },
          name: { type: "string" },
          status: { type: "string" },
          criticality: { type: "string" },
          category: { type: ["string", "null"] },
          manufacturer: { type: ["string", "null"] },
          model: { type: ["string", "null"] },
          updatedAt: { type: "string", format: "date-time" },
          location: { $ref: "#/components/schemas/PublicAssetLocation" },
        },
      },
      PublicAssetCardResult: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/PublicAssetCard" } },
      },
      ApiError: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              details: {},
            },
          },
        },
      },
    },
    responses: {
      BadRequest: {
        description: "Request validation failed.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
      },
      Unauthorized: {
        description: "Scoped bearer token is missing, invalid, expired or revoked.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
      },
      Forbidden: {
        description: "Token capability or origin policy does not allow this operation.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
      },
    },
  },
} as const;
