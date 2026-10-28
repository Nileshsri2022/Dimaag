import type { GraphExport } from "./types";

/**
 * Serialize a full-graph backup to a downloadable blob URL.
 * Caller is responsible for triggering the download and revoking the URL.
 */
export function graphExportToBlobUrl(data: GraphExport): string {
  return URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
}

type ValidateResult = { ok: true } | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Check a record has every listed field with the expected primitive type. Extra fields are fine. */
function checkFields(item: Record<string, unknown>, path: string, fields: [string, string][]): ValidateResult {
  for (const [field, type] of fields) {
    const value = item[field];
    const typeOk =
      type === "array"
        ? Array.isArray(value) && value.every((v) => typeof v === "string")
        : typeof value === type;
    if (!typeOk) {
      return { ok: false, error: `${path}: field "${field}" is missing or not a ${type === "array" ? "string array" : type}` };
    }
  }
  return { ok: true };
}

const DOCUMENT_FIELDS: [string, string][] = [
  ["id", "string"],
  ["url", "string"],
  ["title", "string"],
  ["sourceType", "string"],
  ["capturedAt", "number"],
];

const CHUNK_FIELDS: [string, string][] = [
  ["id", "string"],
  ["documentId", "string"],
  ["text", "string"],
  ["index", "number"],
  ["superseded", "boolean"],
];

const ENTITY_FIELDS: [string, string][] = [
  ["id", "string"],
  ["label", "string"],
  ["name", "string"],
  ["nameNormalized", "string"],
  ["evidenceChunkIds", "array"],
];

const EDGE_FIELDS: [string, string][] = [
  ["id", "string"],
  ["from", "string"],
  ["to", "string"],
  ["type", "string"],
  ["evidenceChunkId", "string"],
];

function validateArray(
  items: unknown,
  name: string,
  fields: [string, string][],
  extraCheck?: (item: Record<string, unknown>) => boolean,
): ValidateResult {
  if (!Array.isArray(items)) {
    return { ok: false, error: `${name}: expected an array` };
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!isObject(item)) {
      return { ok: false, error: `${name}[${i}]: expected an object` };
    }
    const result = checkFields(item, `${name}[${i}]`, fields);
    if (!result.ok) return result;
    if (name === "documents" && item.sourceType !== "page" && item.sourceType !== "selection") {
      return { ok: false, error: `${name}[${i}]: field "sourceType" must be "page" or "selection"` };
    }
  }
  return { ok: true };
}

/**
 * Validate a JSON string as a GraphExport. Requires version === 1, all four
 * arrays present, and every item carrying its required fields with sane types.
 * Extra (internal, e.g. entityKey) fields are accepted so store exports
 * round-trip. Note: this validates shape only — cross-references
 * (documentId / evidenceChunkIds / from / to) are not resolved here.
 */
export function parseGraphExport(json: string): { ok: true; data: GraphExport } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid JSON: ${message}` };
  }

  if (!isObject(parsed)) {
    return { ok: false, error: "Expected a JSON object" };
  }
  if (parsed.version !== 1) {
    return { ok: false, error: `Unsupported export version: ${JSON.stringify(parsed.version)}` };
  }

  const results = [
    validateArray(parsed.documents, "documents", DOCUMENT_FIELDS),
    validateArray(parsed.chunks, "chunks", CHUNK_FIELDS),
    validateArray(parsed.entities, "entities", ENTITY_FIELDS),
    validateArray(parsed.edges, "edges", EDGE_FIELDS),
  ];
  for (const result of results) {
    if (!result.ok) return result;
  }

  return {
    ok: true,
    data: {
      version: 1,
      documents: parsed.documents as GraphExport["documents"],
      chunks: parsed.chunks as GraphExport["chunks"],
      entities: parsed.entities as GraphExport["entities"],
      edges: parsed.edges as GraphExport["edges"],
    },
  };
}
