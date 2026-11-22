import type { FhirError } from "@/hooks/use-fhir-api";
import { APP_REQUEST_HEADER, readStoredRecord } from "@/lib/fhir-config";

export const DEFAULT_SIGN_IN_SCOPE =
  "openid fhirUser launch/patient patient/*.rs";

/** The answer of `GET /auth/status`. It never holds a token, a code, or a secret. */
export interface SignInStatus {
  offered: boolean;
  /** Why the server does not offer sign-in. */
  reason?: string;
  /** True when a URL of the sign-in uses plain `http` on a host that is not local. */
  plainHttp?: boolean;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  capabilities?: string[];
  signedIn: boolean;
  /** The granted scope. */
  scope?: string;
  patient?: string;
  fhirUser?: string;
  /** ISO-8601 instant. */
  expiresAt?: string;
  /** True when a `patient/` scope is granted and the token response names no patient. */
  patientMissing?: boolean;
  /** The client values that the session holds for this server. It never has the secret. */
  client?: SignInFields & {
    /** True when the saved client values have a client secret. */
    hasSecret: boolean;
  };
  /** Why the last sign-in failed. The server sends it one time. */
  error?: string;
}

/** The client values that the server keeps in the session for `server`. */
export interface ClientValues {
  server: string;
  clientId: string;
  /**
   * Empty keeps the saved secret when the saved client id is equal. Else empty
   * saves a public client.
   */
  clientSecret: string;
  scope: string;
}

/** The sign-in uses the client values that the session holds for `server`. */
export interface SignInRequest {
  server: string;
  /**
   * The endpoints of the status that the app shows. The server refuses the
   * sign-in with 409 when its own read of the endpoints gives other values.
   */
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

type SignInFields = Pick<ClientValues, "clientId" | "scope">;

/** The server of this app offers sign-in only together with its proxy. */
export function isSignInAvailable(): boolean {
  return Boolean(window.APP_CONFIG?.proxy && window.APP_CONFIG.login);
}

/** Sends a GET, or a POST of `body` as JSON, with the marker of the app. */
async function authFetch(path: string, body?: object): Promise<Response> {
  const headers = new Headers({ [APP_REQUEST_HEADER]: "1" });
  if (body) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(
    path,
    body
      ? { method: "POST", headers, body: JSON.stringify(body) }
      : { headers },
  );
  if (!response.ok) {
    // The server gives the reason as plain text
    const reason = await response.text().catch(() => "");
    const error: FhirError = new Error(
      reason.trim() || `${response.status} ${response.statusText}`,
    );
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function getSignInStatus(server: string): Promise<SignInStatus> {
  const response = await authFetch(
    `/auth/status?server=${encodeURIComponent(server)}`,
  );
  return response.json();
}

/** Sends the client values to the server, which keeps them in the session. */
export async function saveClient(values: ClientValues): Promise<void> {
  await authFetch("/auth/client", values);
}

/** Starts a sign-in and gives the URL of the authorization server to open. */
export async function startSignIn(request: SignInRequest): Promise<string> {
  const response = await authFetch("/auth/login", request);
  const { authorizeUrl } = await response.json();
  return authorizeUrl;
}

export async function signOut(server: string): Promise<void> {
  await authFetch("/auth/logout", { server });
}

const SIGN_IN_STORAGE_KEY = "fhir-sign-in";

/** The client id and the scope last used for `server`. */
export function getStoredSignInFields(server: string): SignInFields {
  const entry = readStoredRecord(SIGN_IN_STORAGE_KEY)[server] as
    | { clientId?: unknown; scope?: unknown }
    | null
    | undefined;
  return {
    clientId: typeof entry?.clientId === "string" ? entry.clientId : "",
    scope:
      typeof entry?.scope === "string" && entry.scope
        ? entry.scope
        : DEFAULT_SIGN_IN_SCOPE,
  };
}

/**
 * Keeps the client id and the scope for `server`. Only these two fields go
 * into storage, so the client secret is never stored.
 */
export function setStoredSignInFields(
  server: string,
  { clientId, scope }: SignInFields,
): void {
  const record = readStoredRecord(SIGN_IN_STORAGE_KEY);
  record[server] = { clientId, scope };
  localStorage.setItem(SIGN_IN_STORAGE_KEY, JSON.stringify(record));
}
