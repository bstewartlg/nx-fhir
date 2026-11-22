import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import {
  INSECURE_PAGE,
  isInsecurePage,
  SignInButton,
  SignOutButton,
  useReloadAtExpiry,
  useSignInStatus,
  Value,
} from "@/components/sign-in-section";
import { Button } from "@/components/ui/button";
import {
  patientCountKey,
  useRequiresAuthorization,
} from "@/hooks/use-clinical-api";
import { useFhirServer } from "@/hooks/use-fhir-server";

interface SignInGateProps {
  children: ReactNode;
  onOpenSettings: () => void;
}

/**
 * Shows the sign-in page in place of `children` while the selected server
 * answers 401 to the Patient count request.
 */
export function SignInGate({ children, onOpenSettings }: SignInGateProps) {
  const { serverUrl } = useFhirServer();
  const queryClient = useQueryClient();
  const authorization = useRequiresAuthorization();
  // Read from the start together with the header, so the page gets the
  // one-time error of the first status request
  const { server, query: statusQuery } = useSignInStatus(serverUrl);

  // A 401 on a later FHIR request, for example after the token expired,
  // repeats the count request
  useEffect(() => {
    const countKey = patientCountKey(serverUrl);
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "error" &&
        event.action.error?.status === 401 &&
        event.query.queryKey[0] === "fhir" &&
        queryClient.getQueryData(countKey) !== true
      ) {
        queryClient.invalidateQueries({ queryKey: countKey });
      }
    });
  }, [queryClient, serverUrl]);

  // Nothing shows until the first answers arrive, so neither the page nor the
  // content flashes
  if (authorization.isLoading) {
    return null;
  }
  if (!authorization.data) {
    // The page does not show, so the one-time error of a failed sign-in shows
    // here
    const error = statusQuery.data?.error;
    return (
      <>
        {error && <p className="px-6 pt-4 text-sm text-destructive">{error}</p>}
        {children}
      </>
    );
  }
  if (server !== undefined && !statusQuery.isFetched) {
    return null;
  }

  const status = statusQuery.data;
  return (
    <div className="p-6 space-y-3 max-w-xl">
      <h2 className="text-base font-semibold">Sign in</h2>
      <p className="text-sm text-muted-foreground">
        This FHIR server requires authorization.
      </p>
      {server !== undefined && status?.offered ? (
        status.client ? (
          <>
            <Value
              label="Authorization endpoint"
              value={status.authorizationEndpoint ?? ""}
            />
            <Value label="Token endpoint" value={status.tokenEndpoint ?? ""} />
            <Value label="Client id" value={status.client.clientId} />
            <SignInButton server={server} status={status} />
          </>
        ) : isInsecurePage() ? (
          // The settings dialog has no form on this page, so it cannot save
          <p className="text-sm text-destructive">{INSECURE_PAGE}</p>
        ) : (
          <>
            <p className="text-sm">
              Save a client id and scopes for this server in the settings.
            </p>
            <Button variant="outline" size="sm" onClick={onOpenSettings}>
              Open settings
            </Button>
          </>
        )
      ) : (
        <>
          <p className="text-sm">The app found no sign-in for this server.</p>
          {status?.plainHttp && (
            <p className="text-sm text-destructive">{status.reason}</p>
          )}
        </>
      )}
      {status?.error && (
        <p className="text-sm text-destructive">{status.error}</p>
      )}
    </div>
  );
}

/** Shows who is signed in at the selected server, with a Sign out button. */
export function SignedInUser() {
  const { serverUrl } = useFhirServer();
  const {
    server,
    query: { data: status },
  } = useSignInStatus(serverUrl);
  useReloadAtExpiry(server, status?.signedIn ? status.expiresAt : undefined);

  if (server === undefined || !status?.signedIn) {
    return null;
  }
  return (
    <div className="flex items-center gap-2">
      <span
        className="max-w-64 truncate text-xs text-muted-foreground"
        title={status.fhirUser}
      >
        {status.fhirUser ? `Signed in as ${status.fhirUser}` : "Signed in"}
      </span>
      <SignOutButton server={server} />
    </div>
  );
}
