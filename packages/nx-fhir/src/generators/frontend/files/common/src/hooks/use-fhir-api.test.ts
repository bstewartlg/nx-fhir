import { describe, expect, it } from "vitest";
import { type FhirError, retryOnceUnlessClientError } from "./use-fhir-api";

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
