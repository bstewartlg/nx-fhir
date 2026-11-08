export interface FhirServer {
  name: string;
  url: string;
}

export interface CdsServer {
  name: string;
  url: string;
}

interface AppConfig {
  fhirServers?: FhirServer[];
  cdsServers?: CdsServer[];
}

declare global {
  interface Window {
    APP_CONFIG?: AppConfig;
  }
}

const DEFAULT_FHIR_SERVERS: FhirServer[] = [
  {
    name: "Local Server",
    url: "http://localhost:8080/fhir",
  },
];

function isValidFhirServer(server: unknown): server is FhirServer {
  return (
    typeof server === "object" &&
    server !== null &&
    typeof (server as FhirServer).name === "string" &&
    typeof (server as FhirServer).url === "string"
  );
}

function parseFhirServers(): FhirServer[] {
  if (
    window?.APP_CONFIG?.fhirServers &&
    Array.isArray(window.APP_CONFIG.fhirServers)
  ) {
    const servers = window.APP_CONFIG.fhirServers.filter(isValidFhirServer);
    if (servers.length > 0) {
      return servers;
    }
  }

  const envServers = import.meta.env.VITE_FHIR_SERVERS;
  if (envServers) {
    try {
      const parsed = JSON.parse(envServers);
      if (Array.isArray(parsed)) {
        const servers = parsed.filter(isValidFhirServer);
        if (servers.length > 0) {
          return servers;
        }
      }
    } catch {
      console.warn("Failed to parse VITE_FHIR_SERVERS, using defaults");
    }
  }

  return DEFAULT_FHIR_SERVERS;
}

export const FHIR_SERVERS: FhirServer[] = parseFhirServers();

const STORAGE_KEY = "fhir-server-url";

export function getStoredServerUrl(): string {
  if (typeof window === "undefined") {
    return FHIR_SERVERS[0].url;
  }
  return localStorage.getItem(STORAGE_KEY) || FHIR_SERVERS[0].url;
}

export function setStoredServerUrl(url: string): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEY, url);
  }
}

export function getServerByUrl(url: string): FhirServer | undefined {
  return FHIR_SERVERS.find((server) => server.url === url);
}

export interface CustomHeader {
  name: string;
  value: string;
}

/** Hop-by-hop and proxy headers the browser owns, a request cannot set them. */
export const DISALLOWED_HEADER_NAMES = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "proxy-authorization",
  "proxy-authenticate",
]);

/** RFC 7230 token rule, the character set `Headers.set()` accepts for a header name. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

export function isValidHeaderName(name: string): boolean {
  return HEADER_NAME_PATTERN.test(name);
}

/** `Headers.set()` rejects CR, LF, and NUL in a header value. */
export function hasInvalidHeaderValueChars(value: string): boolean {
  return /[\r\n\0]/.test(value);
}

/** Keeps the well-formed, unique entries of a stored header list. */
export function sanitizeCustomHeaders(value: unknown): CustomHeader[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const headers: CustomHeader[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, value: headerValue } = entry as Partial<CustomHeader>;
    if (typeof name !== "string" || typeof headerValue !== "string") continue;
    const trimmed = name.trim();
    const lower = trimmed.toLowerCase();
    if (
      !lower ||
      DISALLOWED_HEADER_NAMES.has(lower) ||
      seen.has(lower) ||
      !isValidHeaderName(trimmed) ||
      hasInvalidHeaderValueChars(headerValue)
    ) {
      continue;
    }
    seen.add(lower);
    headers.push({ name: trimmed, value: headerValue });
  }
  return headers;
}

const SERVER_HEADERS_STORAGE_KEY = "fhir-server-headers";

function readStoredServerHeadersRecord(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(SERVER_HEADERS_STORAGE_KEY) ?? "{}",
    );
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A corrupt record reads as empty
  }
  return {};
}

/** Custom headers sent with every request to the server at `url`, kept per server. */
export function getStoredServerHeaders(url: string): CustomHeader[] {
  if (typeof window === "undefined") {
    return [];
  }
  return sanitizeCustomHeaders(readStoredServerHeadersRecord()[url]);
}

/** Stores the headers for `url` and reports whether the stored value changed. */
export function setStoredServerHeaders(
  url: string,
  headers: CustomHeader[],
): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (JSON.stringify(headers) === JSON.stringify(getStoredServerHeaders(url))) {
    return false;
  }
  const record = readStoredServerHeadersRecord();
  if (headers.length > 0) {
    record[url] = headers;
  } else {
    delete record[url];
  }
  localStorage.setItem(SERVER_HEADERS_STORAGE_KEY, JSON.stringify(record));
  return true;
}
