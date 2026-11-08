import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FhirError,
  fhirRequestHeaders,
  retryOnceUnlessClientError,
  useCapabilityStatement,
  useServerStatus,
} from "./use-fhir-api";

function fhirError(status?: number): FhirError {
  return Object.assign(new Error("failed"), { status });
}

describe("retryOnceUnlessClientError", () => {
  it("retries a server error or a network failure once", () => {
    for (const error of [fhirError(500), fhirError(503), fhirError()]) {
      expect(retryOnceUnlessClientError(0, error)).toBe(true);
      expect(retryOnceUnlessClientError(1, error)).toBe(false);
    }
  });

  it("does not retry a client error", () => {
    for (const status of [400, 401, 403, 404, 410]) {
      expect(retryOnceUnlessClientError(0, fhirError(status))).toBe(false);
    }
  });

  it("retries a timeout or a rate limit once", () => {
    for (const status of [408, 429]) {
      expect(retryOnceUnlessClientError(0, fhirError(status))).toBe(true);
      expect(retryOnceUnlessClientError(1, fhirError(status))).toBe(false);
    }
  });
});

describe("fhirRequestHeaders", () => {
  const server = "http://localhost:8080/fhir";

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("fhir-server-url", server);
    localStorage.setItem(
      "fhir-server-headers",
      JSON.stringify({ [server]: [{ name: "X-Api-Key", value: "k" }] }),
    );
  });

  it("sends the stored headers to the active server, page links included", () => {
    for (const url of [
      server,
      `${server}/metadata`,
      `${server}?_getpages=abc&_getpagesoffset=50`,
      `${server}/Patient?_count=10`,
    ]) {
      const headers = fhirRequestHeaders(url);
      expect(headers.get("X-Api-Key")).toBe("k");
      expect(headers.get("Accept")).toBe("application/fhir+json");
    }
  });

  it("does not send them to another host or a sibling path", () => {
    for (const url of [
      "http://other.example/fhir/metadata",
      `${server}-other/metadata`,
    ]) {
      expect(fhirRequestHeaders(url).get("X-Api-Key")).toBeNull();
    }
  });

  it("matches a server url stored with a trailing slash", () => {
    localStorage.setItem("fhir-server-url", `${server}/`);
    localStorage.setItem(
      "fhir-server-headers",
      JSON.stringify({ [`${server}/`]: [{ name: "X-Api-Key", value: "k" }] }),
    );
    expect(fhirRequestHeaders(`${server}/metadata`).get("X-Api-Key")).toBe("k");
  });
});

describe("metadata query", () => {
  it("serves the status and the capability statement from one request", async () => {
    const capability = {
      resourceType: "CapabilityStatement",
      fhirVersion: "4.0.1",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(capability), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const server = "http://localhost:8080/fhir";

    const { result } = renderHook(
      () => ({
        status: useServerStatus(server),
        capability: useCapabilityStatement(server),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.status.isConnected).toBe(true));
    expect(result.current.capability.data).toEqual(capability);
    expect(result.current.status.latency).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
