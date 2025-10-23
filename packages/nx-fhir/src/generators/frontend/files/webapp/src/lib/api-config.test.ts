import { beforeAll, expect, test } from "vitest";
import { getFhirBaseUrl } from "./api-config";

beforeAll(() => {
  process.env.NEXT_PUBLIC_SERVER_URL = "http://localhost:8081";
});

test("FHIR Base URL using Server URL environment variable", () => {
  expect(getFhirBaseUrl()).toBe("http://localhost:8081/fhir");
});
