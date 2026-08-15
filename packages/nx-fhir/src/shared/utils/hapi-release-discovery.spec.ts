import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchStarterImageVersions,
  matchImageVersion,
} from './hapi-release-discovery';
import { getHapiReleaseUrl } from '../constants/versions';

function releasesResponse(tags: string[]) {
  return {
    ok: true,
    json: async () => tags.map((tag_name) => ({ tag_name })),
  };
}

describe('fetchStarterImageVersions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns image versions and ignores non-image tags', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        releasesResponse([
          'helm-v0.24.0',
          'image/v8.10.0-3',
          'image/v7.6.0',
          'v6.0.1',
        ]),
      ),
    );

    expect(await fetchStarterImageVersions()).toEqual(['8.10.0-3', '7.6.0']);
  });

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
    expect(await fetchStarterImageVersions()).toBeNull();
  });

  it('returns null when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await fetchStarterImageVersions()).toBeNull();
  });
});

describe('matchImageVersion', () => {
  const images = ['7.4.0', '7.6.0', '8.0.0', '8.0.0-1', '8.0.0-2', '8.6.5-1'];

  it('matches exactly when the pom names its revision', () => {
    expect(matchImageVersion(images, '8.6.5', '1')).toBe('8.6.5-1');
  });

  it('returns undefined when the named revision is not published', () => {
    expect(matchImageVersion(images, '8.6.5', '9')).toBeUndefined();
  });

  it('matches by base version when exactly one image shares it', () => {
    expect(matchImageVersion(images, '7.6.0')).toBe('7.6.0');
  });

  it('returns undefined when several images share the base version', () => {
    expect(matchImageVersion(images, '8.0.0')).toBeUndefined();
  });

  it('returns undefined when no image shares the base version', () => {
    expect(matchImageVersion(images, '6.8.0')).toBeUndefined();
  });
});

describe('getHapiReleaseUrl', () => {
  it('uses the curated URL for a tested release', () => {
    expect(getHapiReleaseUrl('8.4.0-2')).toContain('image/v8.4.0-2.zip');
  });

  it('derives the image tag URL for other releases', () => {
    expect(getHapiReleaseUrl('7.6.0')).toBe(
      'https://github.com/hapifhir/hapi-fhir-jpaserver-starter/archive/refs/tags/image/v7.6.0.zip',
    );
  });
});
