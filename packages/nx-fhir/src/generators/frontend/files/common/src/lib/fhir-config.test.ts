import { beforeEach, describe, expect, it } from "vitest";
import {
  headerEditorError,
  validCustomHeaders,
} from "@/components/header-editor";
import {
  getStoredServerHeaders,
  sanitizeCustomHeaders,
  setStoredServerHeaders,
} from "./fhir-config";

describe("sanitizeCustomHeaders", () => {
  it("keeps well-formed unique headers and trims the name", () => {
    expect(
      sanitizeCustomHeaders([
        { name: " X-Api-Key ", value: "abc" },
        { name: "x-api-key", value: "dup" },
        { name: "Accept", value: "text/plain" },
      ]),
    ).toEqual([
      { name: "X-Api-Key", value: "abc" },
      { name: "Accept", value: "text/plain" },
    ]);
  });

  it("drops malformed entries, hop-by-hop names, and bad values", () => {
    expect(
      sanitizeCustomHeaders([
        null,
        "x",
        { name: 1, value: "a" },
        { name: "Host", value: "evil" },
        { name: "", value: "a" },
        { name: "Bad Name", value: "a" },
        { name: "X-Ok", value: "a\r\nInjected: b" },
      ]),
    ).toEqual([]);
    expect(sanitizeCustomHeaders("nope")).toEqual([]);
  });
});

describe("stored server headers", () => {
  beforeEach(() => localStorage.clear());

  it("keeps headers per server and removes an emptied entry", () => {
    setStoredServerHeaders("http://a/fhir", [{ name: "X-A", value: "1" }]);
    setStoredServerHeaders("http://b/fhir", [{ name: "X-B", value: "2" }]);
    expect(getStoredServerHeaders("http://a/fhir")).toEqual([
      { name: "X-A", value: "1" },
    ]);
    expect(getStoredServerHeaders("http://b/fhir")).toEqual([
      { name: "X-B", value: "2" },
    ]);
    setStoredServerHeaders("http://a/fhir", []);
    expect(getStoredServerHeaders("http://a/fhir")).toEqual([]);
    expect(getStoredServerHeaders("http://b/fhir")).toHaveLength(1);
  });

  it("reports whether the stored headers changed", () => {
    const headers = [{ name: "X-A", value: "1" }];
    expect(setStoredServerHeaders("http://a/fhir", [])).toBe(false);
    expect(setStoredServerHeaders("http://a/fhir", headers)).toBe(true);
    expect(setStoredServerHeaders("http://a/fhir", headers)).toBe(false);
    expect(setStoredServerHeaders("http://a/fhir", [])).toBe(true);
  });

  it("reads a corrupt record as empty", () => {
    localStorage.setItem("fhir-server-headers", "{not json");
    expect(getStoredServerHeaders("http://a/fhir")).toEqual([]);
    localStorage.setItem(
      "fhir-server-headers",
      JSON.stringify({ "http://a/fhir": [{ name: "Host", value: "x" }] }),
    );
    expect(getStoredServerHeaders("http://a/fhir")).toEqual([]);
  });
});

describe("headerEditorError", () => {
  it("accepts valid rows and rows still being typed", () => {
    expect(
      headerEditorError([
        { name: "X-Api-Key", value: "abc" },
        { name: "", value: "" },
      ]),
    ).toBeUndefined();
  });

  it("names the first problem", () => {
    expect(headerEditorError([{ name: "", value: "v" }])).toBe(
      "Header value needs a name",
    );
    expect(headerEditorError([{ name: "Host", value: "v" }])).toMatch(
      /cannot be sent/,
    );
    expect(headerEditorError([{ name: "a b", value: "v" }])).toMatch(
      /not a valid header name/,
    );
    expect(headerEditorError([{ name: "X", value: "a\nb" }])).toMatch(
      /invalid value/,
    );
    expect(
      headerEditorError([
        { name: "X", value: "1" },
        { name: "x", value: "2" },
      ]),
    ).toMatch(/Duplicate/);
  });
});

describe("validCustomHeaders", () => {
  it("drops nameless rows and trims names", () => {
    expect(
      validCustomHeaders([
        { name: " X ", value: "1" },
        { name: "", value: "" },
      ]),
    ).toEqual([{ name: "X", value: "1" }]);
  });
});
