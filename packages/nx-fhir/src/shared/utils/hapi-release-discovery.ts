const STARTER_RELEASES_API =
  'https://api.github.com/repos/hapifhir/hapi-fhir-jpaserver-starter/releases?per_page=100';
const IMAGE_TAG_PREFIX = 'image/v';

/**
 * Lists every starter image version published on GitHub (for example "7.6.0"
 * or "8.6.5-1"). Returns null when the API cannot be reached, so callers can
 * fall back to offline behavior.
 */
export async function fetchStarterImageVersions(): Promise<string[] | null> {
  try {
    const response = await fetch(STARTER_RELEASES_API, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      return null;
    }
    const releases = (await response.json()) as { tag_name?: string }[];
    return releases
      .map((release) => release.tag_name ?? '')
      .filter((tag) => tag.startsWith(IMAGE_TAG_PREFIX))
      .map((tag) => tag.slice(IMAGE_TAG_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * Finds the single published image a pom can correspond to.
 *
 * With a starter revision the pom names its image exactly. Without one, poms
 * predate the revision property and match by base version, which is only
 * conclusive when exactly one published image shares that base.
 */
export function matchImageVersion(
  imageVersions: string[],
  parentBase: string,
  revision?: string,
): string | undefined {
  if (revision) {
    const exact = `${parentBase}-${revision}`;
    return imageVersions.includes(exact) ? exact : undefined;
  }

  const family = imageVersions.filter(
    (version) =>
      version === parentBase || version.startsWith(`${parentBase}-`),
  );
  return family.length === 1 ? family[0] : undefined;
}
