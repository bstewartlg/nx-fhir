import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SUPPORTED_HAPI_VERSIONS, starterImageZipUrl } from '../constants/versions';
import {
  appendDockerignoreLines,
  dockerfileMergeSides,
  DockerFragments,
  frontendStageBuilds,
  insertFrontendLines,
  isCombinedDockerfile,
  isServerRootLayout,
  legacyDockerWarning,
  removeDockerignoreLines,
  removeFrontendLines,
  renderDockerFragments,
} from './docker-splice';
import { threeWayMerge } from './merge';
import { getCiInstallCommand, getDockerBaseImage, getLockfileName, getRunCommand } from './package-manager';

const fixtureDir = join(__dirname, '__fixtures__', 'starter-docker');
const readFixture = (file: string) => readFileSync(join(fixtureDir, file), 'utf-8');

const releases: Record<string, { dockerfile: string; dockerignore: string }> = JSON.parse(
  readFixture('releases.json'),
);
const starter = (release: string) => readFixture(releases[release].dockerfile);
const ignore = (release: string) => readFixture(releases[release].dockerignore);

const distinctDockerfiles = [...new Set(Object.values(releases).map((files) => files.dockerfile))];
const changingSteps = SUPPORTED_HAPI_VERSIONS.slice(1)
  .map((to, index) => [SUPPORTED_HAPI_VERSIONS[index], to])
  .filter(([from, to]) => releases[from]?.dockerfile !== releases[to]?.dockerfile);

const fragments: DockerFragments = {
  frontendStage: 'FROM oven/bun:1-slim AS build-frontend\nWORKDIR /app\nRUN bun run build\n',
  copyFrontend:
    'COPY --from=build-frontend /app/frontend/dist/ /tmp/hapi-fhir-jpaserver-starter/src/main/resources/static/\n',
  dockerignoreLines: 'node_modules\nfrontend/node_modules\nfrontend/dist\n',
};

const inserted = (dockerfile: string) => insertFrontendLines(dockerfile, fragments) as string;

describe('docker-splice', () => {
  it.each(distinctDockerfiles)(
    'inserts the stage above the first FROM and the COPY after COPY src/ in %s',
    (file) => {
      const original = readFixture(file);
      const lines = inserted(original).split('\n');

      expect(lines.slice(0, 3)).toEqual(fragments.frontendStage.split('\n').slice(0, 3));
      expect(lines[3]).toBe('');
      expect(lines[4]).toBe(original.split('\n').find((line) => line.startsWith('FROM')));
      const copySource = lines.indexOf('COPY src/ /tmp/hapi-fhir-jpaserver-starter/src/');
      expect(copySource).toBeGreaterThan(4);
      expect(lines[copySource + 1]).toBe(fragments.copyFrontend.trimEnd());
    },
  );

  it.each(distinctDockerfiles)('removes what it inserted in %s', (file) => {
    const original = readFixture(file);
    expect(removeFrontendLines(inserted(original))).toBe(original);
  });

  it.each(changingSteps)(
    'merges the starter upgrade %s to %s into a file with the frontend lines',
    (from, to) => {
      const result = threeWayMerge(starter(from), inserted(starter(from)), starter(to), 'Dockerfile');

      if (from === '8.6.0-1' && to === '8.6.5-1') {
        expect(result.status).toBe('conflict');
      } else {
        expect(result.status).toBe('merged');
        expect(result.content).toBe(inserted(starter(to)));
      }
    },
  );

  it('merges the starter .dockerignore upgrade', () => {
    const result = threeWayMerge(
      ignore('8.4.0-2'),
      appendDockerignoreLines(ignore('8.4.0-2'), fragments.dockerignoreLines),
      ignore('8.4.0-3'),
      '.dockerignore',
    );

    expect(result.status).toBe('merged');
    expect(result.content).toBe(appendDockerignoreLines(ignore('8.4.0-3'), fragments.dockerignoreLines));
  });

  it('maps every supported release to a fixture', () => {
    for (const release of SUPPORTED_HAPI_VERSIONS) {
      expect(releases[release], release).toBeDefined();
      expect(existsSync(join(fixtureDir, releases[release].dockerfile)), release).toBe(true);
      expect(existsSync(join(fixtureDir, releases[release].dockerignore)), release).toBe(true);
    }
  });

  it('keeps CRLF line endings', () => {
    const crlf = starter('8.12.0-2').replace(/\n/g, '\r\n');
    const result = inserted(crlf);

    expect(result).not.toMatch(/(?<!\r)\n/);
    expect(removeFrontendLines(result)).toBe(crlf);
  });

  it('matches lowercase instructions and a platform flag', () => {
    expect(
      isCombinedDockerfile('from node as build-frontend\nfrom --platform=linux/amd64 maven as build-server\n'),
    ).toBe(true);
    expect(insertFrontendLines('from maven as build-hapi\ncopy src/ /x/\n', fragments)).toBe(
      `${fragments.frontendStage}\nfrom maven as build-hapi\ncopy src/ /x/\n${fragments.copyFrontend}`,
    );
  });

  it('keeps a parser directive and a global ARG above the stage', () => {
    const result = inserted('# syntax=docker/dockerfile:1\nARG V=1\nFROM maven AS build-hapi\nCOPY src/ /x/\n');

    expect(result).toBe(
      `# syntax=docker/dockerfile:1\nARG V=1\n${fragments.frontendStage}\nFROM maven AS build-hapi\nCOPY src/ /x/\n${fragments.copyFrontend}`,
    );
  });

  it('returns null without a COPY src/ line', () => {
    expect(insertFrontendLines('FROM maven AS build-hapi\nCOPY ./src/ /x/\n', fragments)).toBeNull();
  });

  it('tells the combined form from the starter form', () => {
    expect(isCombinedDockerfile('FROM a AS build-frontend\nFROM b AS build-server\n')).toBe(true);
    for (const file of distinctDockerfiles) {
      expect(isCombinedDockerfile(readFixture(file)), file).toBe(false);
      expect(isCombinedDockerfile(inserted(readFixture(file))), file).toBe(false);
    }
  });

  it('finds the server-root layout', () => {
    expect(isServerRootLayout('.', 'frontend')).toBe(true);
    expect(isServerRootLayout('.', 'apps/web')).toBe(false);
    expect(isServerRootLayout('server', 'server/frontend')).toBe(false);
    expect(isServerRootLayout('server', 'frontend')).toBe(false);
  });

  it('tells which frontend the stage builds', () => {
    const withStage = (root: string) =>
      `FROM oven/bun:1-slim AS build-frontend\nWORKDIR /app\nWORKDIR /app/${root}\nRUN bun run build\n\n` +
      'FROM maven AS build-hapi\nWORKDIR /app/other\n';

    expect(frontendStageBuilds(withStage('web'), 'web')).toBe(true);
    expect(frontendStageBuilds(withStage('web'), 'web2')).toBe(false);
    expect(frontendStageBuilds(withStage('web2'), 'web')).toBe(false);
    expect(frontendStageBuilds(withStage('web'), 'other')).toBe(false);
    expect(frontendStageBuilds(withStage('web').replace('WORKDIR /app/web', 'workdir /app/web'), 'web')).toBe(true);
    expect(frontendStageBuilds(withStage('web').replace(/\n/g, '\r\n'), 'web')).toBe(true);
    expect(frontendStageBuilds('FROM maven AS build-hapi\nWORKDIR /app/web\n', 'web')).toBe(false);
  });

  it.each([false, true])('finds the frontend root in the rendered stage of a workspace member: %s', (workspaceMember) => {
    const rendered = renderDockerFragments(join(__dirname, '../../generators/frontend/files'), {
      frontendRoot: 'web',
      dockerBaseImage: getDockerBaseImage('bun'),
      lockfileName: getLockfileName('bun'),
      ciInstallCommand: getCiInstallCommand('bun'),
      buildCommand: getRunCommand('bun', 'build'),
      workspaceMember,
    }) as DockerFragments;
    const dockerfile = insertFrontendLines(starter('8.12.0-2'), rendered) as string;

    expect(frontendStageBuilds(dockerfile, 'web')).toBe(true);
  });

  it('appends ignore lines after a file with no final newline', () => {
    expect(appendDockerignoreLines('a\n.git', 'x\n')).toBe('a\n.git\nx\n');
    expect(appendDockerignoreLines('a\n', 'x\n')).toBe('a\nx\n');
  });

  it('keeps an ignore line the user edited', () => {
    expect(
      removeDockerignoreLines('.git\nnode_modules\nfrontend/node_modules/\n', fragments.dockerignoreLines),
    ).toBe('.git\nfrontend/node_modules/\n');
  });

  it('builds merge sides from the project file', () => {
    const hapiStage = 'FROM docker.io/library/maven:3.9.12-eclipse-temurin-17 AS build-hapi\n';
    const current = inserted(starter('8.12.0-2')).replace(hapiStage, `${hapiStage}# user\n`);
    const newFragments = { ...fragments, frontendStage: `${fragments.frontendStage}RUN bun run test\n` };

    expect(current).toContain(`${hapiStage}# user\n`);
    expect(dockerfileMergeSides(current, fragments, newFragments)).toEqual({
      base: current,
      next: current.replace('RUN bun run build\n', 'RUN bun run build\nRUN bun run test\n'),
    });
    expect(dockerfileMergeSides('FROM a\n', fragments, fragments)).toBeNull();
    expect(dockerfileMergeSides(fragments.frontendStage, fragments, fragments)).toBeNull();
  });

  it('names the release, the starter download, and the lines in the legacy warning', () => {
    const warning = legacyDockerWarning('8.12.0-2', fragments).join('\n');

    expect(warning).toContain('8.12.0-2');
    expect(warning).toContain(starterImageZipUrl('8.12.0-2'));
    expect(warning).toContain('Dockerfile.orig');
    expect(warning).toContain('\n2. Keep a copy of the combined Dockerfile and .dockerignore');
    expect(warning).toContain('\n4. Carry over, from that copy, any change you made to the combined files');
    expect(warning).toMatch(/\n8\. After the switch, you can delete Dockerfile\.orig and \.dockerignore\.orig\.$/);
    for (const fragment of Object.values(fragments)) {
      expect(warning).toContain(fragment.trimEnd());
    }

    const unknownRelease = legacyDockerWarning(undefined, fragments).join('\n');
    expect(unknownRelease).toContain("your server's HAPI release");
    expect(unknownRelease).not.toContain('https://');
  });

  it('renders the fragments shipped with the plugin', () => {
    const rendered = renderDockerFragments(join(__dirname, '../../generators/frontend/files'), {
      dot: '.',
      frontendRoot: 'frontend',
      serverRoot: 'server',
      dockerBaseImage: getDockerBaseImage('bun'),
      lockfileName: getLockfileName('bun'),
      ciInstallCommand: getCiInstallCommand('bun'),
      buildCommand: getRunCommand('bun', 'build'),
      workspaceMember: false,
      healthCheck: false,
    });

    expect(rendered?.frontendStage).toMatch(/^FROM oven\/bun:/);
    expect(rendered?.frontendStage).toContain('AS build-frontend');
    expect(rendered?.copyFrontend).toBe(
      'COPY --from=build-frontend /app/frontend/dist/ /tmp/hapi-fhir-jpaserver-starter/src/main/resources/static/\n',
    );
    expect(rendered?.dockerignoreLines).toBe(
      'node_modules\nfrontend/node_modules\nfrontend/dist\nfrontend/.tanstack\n' +
        'frontend/src/**/*.test.ts\nfrontend/src/**/*.test.tsx\nfrontend/src/**/*.spec.ts\nfrontend/src/**/*.spec.tsx\n',
    );
  });

  it('returns null for a version without fragments', () => {
    const filesDir = mkdtempSync(join(tmpdir(), 'nx-fhir-files-'));
    try {
      expect(renderDockerFragments(filesDir, {})).toBeNull();
    } finally {
      rmSync(filesDir, { recursive: true, force: true });
    }
  });
});
