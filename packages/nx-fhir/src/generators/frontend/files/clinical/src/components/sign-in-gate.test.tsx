import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fhirFetch } from "@/hooks/use-fhir-api";
import { SignedInUser, SignInGate } from "./sign-in-gate";

// The server list of the app is read when fhir-config loads, so proxy mode
// must be on before the imports run
vi.hoisted(() => {
  window.APP_CONFIG = { proxy: { passthrough: false }, login: {} };
});

const content = "Patient search";
const offered = {
  offered: true,
  authorizationEndpoint: "https://auth.example.org/authorize",
  tokenEndpoint: "https://auth.example.org/token",
  capabilities: [],
  signedIn: false,
};

let status: object;
let countAnswer: () => Response;

/** A FHIR request of the content, which the server answers with 401. */
function Content() {
  useQuery({
    queryKey: ["fhir", "Condition"],
    queryFn: () => fhirFetch(`${window.location.origin}/fhir/Condition`),
  });
  return <p>{content}</p>;
}

function renderWithQueries(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

function renderGate(onOpenSettings = vi.fn()) {
  renderWithQueries(
    <SignInGate onOpenSettings={onOpenSettings}>
      <p>{content}</p>
    </SignInGate>,
  );
}

describe("SignInGate", () => {
  beforeEach(() => {
    countAnswer = () => new Response(null, { status: 401 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/auth/status")) {
          return new Response(JSON.stringify(status));
        }
        if (url.includes("_summary=count")) {
          return countAnswer();
        }
        return new Response(null, { status: 401 });
      }),
    );
  });

  it("shows the endpoints, the client id, and Sign in when the client values are saved", async () => {
    status = {
      ...offered,
      client: { clientId: "app-1", scope: "openid patient/*.rs" },
    };
    renderGate();

    expect(
      await screen.findByRole("button", { name: "Sign in" }),
    ).toBeInTheDocument();
    expect(screen.getByText(offered.authorizationEndpoint)).toBeInTheDocument();
    expect(screen.getByText(offered.tokenEndpoint)).toBeInTheDocument();
    expect(screen.getByText("app-1")).toBeInTheDocument();
    expect(screen.queryByText(content)).toBeNull();
  });

  it("opens the settings when no client values are saved", async () => {
    status = offered;
    const onOpenSettings = vi.fn();
    renderGate(onOpenSettings);

    fireEvent.click(
      await screen.findByRole("button", { name: "Open settings" }),
    );
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("says that the app found no sign-in, with the plain http reason and the reason of a failed sign-in", async () => {
    const reason = "The server URL uses plain http.";
    status = {
      offered: false,
      plainHttp: true,
      reason,
      signedIn: false,
      error: "The sign-in failed",
    };
    renderGate();

    expect(
      await screen.findByText("The app found no sign-in for this server."),
    ).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.getByText("The sign-in failed")).toBeInTheDocument();
    expect(screen.queryByText(content)).toBeNull();
  });

  it("shows the content and the reason of a failed sign-in when the count request does not answer 401", async () => {
    status = { ...offered, error: "The sign-in failed" };
    countAnswer = () =>
      new Response(JSON.stringify({ resourceType: "Bundle", total: 0 }));
    renderGate();

    expect(await screen.findByText("The sign-in failed")).toBeInTheDocument();
    expect(screen.getByText(content)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  });

  it("shows the page when a later FHIR request answers 401", async () => {
    status = offered;
    let countCalls = 0;
    countAnswer = () =>
      countCalls++ === 0
        ? new Response(JSON.stringify({ resourceType: "Bundle", total: 0 }))
        : new Response(null, { status: 401 });
    renderWithQueries(
      <SignInGate onOpenSettings={vi.fn()}>
        <Content />
      </SignInGate>,
    );

    await screen.findByText(content);
    expect(
      await screen.findByRole("button", { name: "Open settings" }),
    ).toBeInTheDocument();
    expect(countCalls).toBe(2);
  });
});

describe("SignedInUser", () => {
  it("shows who is signed in and Sign out", async () => {
    const fhirUser = `${window.location.origin}/fhir/Patient/1002`;
    status = { ...offered, signedIn: true, fhirUser };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(status))),
    );
    renderWithQueries(<SignedInUser />);

    expect(
      await screen.findByText(`Signed in as ${fhirUser}`),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
  });
});
