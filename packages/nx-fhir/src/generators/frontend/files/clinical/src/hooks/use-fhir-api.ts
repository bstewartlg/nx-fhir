import { useQuery } from "@tanstack/react-query";
import type { CapabilityStatement, OperationOutcome } from "fhir/r4";
import { isOperationOutcome } from "@/lib/fhir-types";

interface FhirError extends Error {
  status?: number;
  operationOutcome?: OperationOutcome;
}

export async function fhirFetch<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/fhir+json",
    },
  });

  if (!response.ok) {
    const error: FhirError = new Error(
      `FHIR request failed: ${response.status} ${response.statusText}`,
    );
    error.status = response.status;
    try {
      const body = await response.json();
      if (isOperationOutcome(body)) {
        error.operationOutcome = body;
        error.message =
          body.issue[0]?.diagnostics ||
          body.issue[0]?.details?.text ||
          error.message;
      }
    } catch {
      // Ignore JSON parse errors
    }
    throw error;
  }

  return response.json();
}

export function useCapabilityStatement(serverUrl: string) {
  return useQuery({
    queryKey: ["fhir", "metadata", serverUrl],
    queryFn: () => fhirFetch<CapabilityStatement>(`${serverUrl}/metadata`),
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1,
    enabled: !!serverUrl,
  });
}

export function useServerStatus(serverUrl: string) {
  const query = useQuery({
    queryKey: ["fhir", "status", serverUrl],
    queryFn: async () => {
      const start = Date.now();
      const capability = await fhirFetch<CapabilityStatement>(
        `${serverUrl}/metadata`,
      );
      const latency = Date.now() - start;
      return {
        connected: true,
        latency,
        capability,
      };
    },
    staleTime: 30 * 1000, // 30 seconds
    retry: 0,
    enabled: !!serverUrl,
  });

  return {
    ...query,
    isConnected: query.isSuccess,
    isDisconnected: query.isError,
    latency: query.data?.latency,
  };
}
