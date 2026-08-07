export const PUBLIC_API_VERSION = "1.1.0";

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
  ],
  paths: {
    "/api/v1/public/maintenance-requests": {
      options: {
        tags: ["Public maintenance requests"],
        summary: "Validate CORS preflight for a scoped request token",
        parameters: [
          {
            name: "tokenId",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1 },
            description: "Non-secret public request token identifier.",
          },
          {
            name: "Origin",
            in: "header",
            required: true,
            schema: { type: "string", format: "uri" },
          },
        ],
        responses: {
          "204": { description: "Origin is allowed for the active token." },
          "400": { description: "tokenId or Origin is missing." },
          "403": { description: "Token is inactive or the origin is not allowed." },
        },
      },
      post: {
        tags: ["Public maintenance requests"],
        summary: "Create a scoped maintenance request",
        description:
          "Creates a REQUESTED, NORMAL-priority CORRECTIVE work order in the site bound to the scoped token. Replays with the same Idempotency-Key return the original work order and trackingId.",
        operationId: "createPublicMaintenanceRequestV1",
        security: [{ scopedPublicRequestToken: [] }],
        parameters: [
          {
            name: "tokenId",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1 },
            description: "Non-secret token identifier paired with the bearer secret.",
          },
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 8, maxLength: 200 },
          },
          {
            name: "Origin",
            in: "header",
            required: false,
            schema: { type: "string", format: "uri" },
            description: "Required for EMBEDDED tokens and validated against exact allowed origins.",
          },
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
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublicMaintenanceRequestResult" },
              },
            },
          },
          "200": {
            description: "Idempotent replay; original work order and trackingId returned.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublicMaintenanceRequestResult" },
              },
            },
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
        parameters: [
          { name: "tokenId", in: "query", required: true, schema: { type: "string", minLength: 1 } },
          { name: "Origin", in: "header", required: true, schema: { type: "string", format: "uri" } },
        ],
        responses: {
          "204": { description: "Origin is allowed for the active token." },
          "400": { description: "tokenId or Origin is missing." },
          "403": { description: "Token is inactive or the origin is not allowed." },
        },
      },
      get: {
        tags: ["Public maintenance requests"],
        summary: "Read the public status of a previously created maintenance request",
        description:
          "Requires the same active scoped token used to create the request plus the opaque trackingId returned by request creation. Only a minimal public status projection is returned.",
        operationId: "getPublicMaintenanceRequestStatusV1",
        security: [{ scopedPublicRequestToken: [] }],
        parameters: [
          { name: "tokenId", in: "query", required: true, schema: { type: "string", minLength: 1 } },
          { name: "trackingId", in: "query", required: true, schema: { type: "string", minLength: 1 } },
          {
            name: "Origin",
            in: "header",
            required: false,
            schema: { type: "string", format: "uri" },
            description: "Required for EMBEDDED tokens and validated against exact allowed origins.",
          },
        ],
        responses: {
          "200": {
            description: "Minimal public work-order status.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublicMaintenanceStatusResult" },
              },
            },
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
  },
  components: {
    securitySchemes: {
      scopedPublicRequestToken: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "opaque scoped token",
        description:
          "Short-lived/revocable site-scoped token. The raw secret is returned only when the token is created and is not an administrator credential.",
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
        description: "Origin is not allowed for this token.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
      },
    },
  },
} as const;
