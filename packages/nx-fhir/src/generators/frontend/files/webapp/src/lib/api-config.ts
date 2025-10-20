
/**
 * Get the normalized server base URL without trailing slash. 
 * Checks localStorage first, then NEXT_PUBLIC_SERVER_URL environment variable, then defaults.
 */
export function getServerBaseUrl(): string {
  // Check localStorage for user override (client-side only)
  if (typeof window !== 'undefined') {
    const savedUrl = localStorage.getItem('serverBaseUrl');
    if (savedUrl) {
      return savedUrl.endsWith('/') ? savedUrl.slice(0, -1) : savedUrl;
    }
  }
  
  // Fall back to environment variable or default to current origin in production and hostname:8080 in development
  const base = process.env.NEXT_PUBLIC_SERVER_URL || 
    (process.env.NODE_ENV === 'production' 
      ? (typeof window !== 'undefined' ? window.location.origin : '') 
      : (typeof window !== 'undefined' ? `http://${window.location.hostname}:8080` : 'http://localhost:8080'));
  const normalizedPath = base.endsWith('/') ? base.slice(0, -1) : base;
  return normalizedPath;
}

/**
 * Get the FHIR server base URL.
 * Checks localStorage first, then NEXT_PUBLIC_FHIR_SERVER_URL environment variable, then constructs from server base URL.
 */
export function getFhirBaseUrl(): string {
  // Check localStorage for user override (client-side only)
  if (typeof window !== 'undefined') {
    const savedUrl = localStorage.getItem('fhirServerUrl');
    if (savedUrl) {
      return savedUrl;
    }
  }
  
  // Fall back to environment variable
  if (process.env.NEXT_PUBLIC_FHIR_SERVER_URL) {
    return process.env.NEXT_PUBLIC_FHIR_SERVER_URL;
  }
  
  // Construct from server base URL
  const base = getServerBaseUrl();
  return `${base}/fhir`;
}
