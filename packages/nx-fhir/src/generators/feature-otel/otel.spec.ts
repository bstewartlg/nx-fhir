import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  logger,
  readProjectConfiguration,
} from '@nx/devkit';
import { parseDocument } from 'yaml';

import { otelFeature } from './otel';
import { runFeature } from '../feature/run-feature';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const input = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ input, confirm }));

const isInteractive = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

const javaRoot = 'test-project/src/main/java/com/example';
const javaTestRoot = 'test-project/src/test/java/com/example';
const yamlPath = 'test-project/src/main/resources/application.yaml';
const pomPath = 'test-project/pom.xml';
const docPath = 'test-project/OTEL.md';
const agentPropertiesPath = 'test-project/otel/agent.properties';
const composePath = 'test-project/docker-compose.otel.yml';
const dashboardDir = 'test-project/otel/grafana/dashboards';
const provisioningDir = 'test-project/otel/grafana/provisioning/dashboards';

function starterPom(hapiVersion: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>ca.uhn.hapi.fhir</groupId>
        <artifactId>hapi-fhir</artifactId>
        <version>${hapiVersion}</version>
    </parent>
    <artifactId>hapi-fhir-jpaserver-starter</artifactId>
    <dependencies>
        <dependency>
            <groupId>ca.uhn.hapi.fhir</groupId>
            <artifactId>hapi-fhir-base</artifactId>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
    <profiles>
        <profile>
            <id>boot</id>
            <dependencies>
                <dependency>
                    <groupId>org.springframework.boot</groupId>
                    <artifactId>spring-boot-starter-web</artifactId>
                </dependency>
            </dependencies>
        </profile>
    </profiles>
</project>
`;
}

function createServerTree(hapiVersion = '8.4.0'): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write('test-project/src/main/java/.gitkeep', '');
  tree.write(pomPath, starterPom(hapiVersion));
  tree.write(yamlPath, 'hapi:\n  fhir:\n    fhir_version: R4\n');
  addProjectConfiguration(tree, 'server', {
    root: 'test-project',
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
  } as ServerProjectConfiguration);
  return tree;
}

function serverProject(tree: Tree): ServerProjectConfiguration {
  return readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
}

function readYaml(tree: Tree, file: string) {
  return parseDocument(tree.read(file, 'utf-8') as string).toJS();
}

const resolvedOptions = {
  serviceName: 'server',
  dashboard: true,
  compose: true,
  serve: true,
};

describe('otel feature', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createServerTree();
    isInteractive.mockReturnValue(false);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('collectOptions', () => {
    it('defaults serviceName to the project name and the three toggles to true when non-interactive', async () => {
      const options = await otelFeature.collectOptions(
        tree,
        serverProject(tree),
        {},
      );

      expect(options).toEqual(resolvedOptions);
      expect(input).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    });

    it('prompts for serviceName and each toggle when interactive', async () => {
      isInteractive.mockReturnValue(true);
      input.mockResolvedValue('my-svc');
      confirm
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const options = await otelFeature.collectOptions(
        tree,
        serverProject(tree),
        {},
      );

      expect(options).toEqual({
        serviceName: 'my-svc',
        dashboard: false,
        compose: true,
        serve: false,
      });
      expect(input).toHaveBeenCalledTimes(1);
      expect(input.mock.calls[0][0].default).toBe('server');
      expect(confirm).toHaveBeenCalledTimes(3);
      expect(confirm.mock.calls[0][0].message).toContain('dashboard');
      expect(confirm.mock.calls[1][0].message).toContain('docker-compose');
      expect(confirm.mock.calls[2][0].message).toContain('serve');
      for (const [prompt] of confirm.mock.calls) {
        expect(prompt.default).toBe(true);
      }
    });

    it('accepts string booleans from the picker', async () => {
      const options = await otelFeature.collectOptions(
        tree,
        serverProject(tree),
        { serviceName: 'my-svc', dashboard: 'false', compose: 'TRUE', serve: false },
      );

      expect(options).toEqual({
        serviceName: 'my-svc',
        dashboard: false,
        compose: true,
        serve: false,
      });
    });

    it.each([
      ['a space', 'my svc'],
      ['a dot', 'my.svc'],
      ['more than 40 characters', 'a'.repeat(41)],
    ])('rejects a serviceName with %s', async (_, serviceName) => {
      await expect(
        otelFeature.collectOptions(tree, serverProject(tree), {
          serviceName,
        }),
      ).rejects.toThrow(
        `Invalid serviceName '${serviceName}'. Use up to 40 letters, digits, _ or - (it becomes the Grafana dashboard uid)`,
      );
    });
  });

  describe('apply', () => {
    it('writes the Java sources and the test under packageBase', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);

      for (const file of [
        `${javaRoot}/telemetry/FhirRouteInterceptor.java`,
        `${javaRoot}/telemetry/TelemetryProperties.java`,
        `${javaRoot}/TelemetryConfig.java`,
        `${javaTestRoot}/telemetry/FhirRouteInterceptorTest.java`,
        `${javaTestRoot}/TelemetryConfigTest.java`,
      ]) {
        expect(tree.exists(file), `${file} should exist`).toBe(true);
      }
    });

    it('renders the package declaration from packageBase', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);

      expect(
        tree.read(`${javaRoot}/telemetry/FhirRouteInterceptor.java`, 'utf-8'),
      ).toContain('package com.example.telemetry;');
      expect(
        tree.read(`${javaTestRoot}/telemetry/FhirRouteInterceptorTest.java`, 'utf-8'),
      ).toContain('package com.example.telemetry;');

      const config = tree.read(`${javaRoot}/TelemetryConfig.java`, 'utf-8');
      expect(config).toContain('package com.example;');
      expect(config).toContain('import com.example.telemetry.FhirRouteInterceptor;');
      expect(config).toContain('.replace("${requestParameters}", "")');
    });

    it('adds the version segment for a version read only', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);

      expect(
        tree.read(`${javaRoot}/telemetry/FhirRouteInterceptor.java`, 'utf-8'),
      ).toContain(
        'if (details.getRestOperationType() == RestOperationTypeEnum.VREAD && id.hasVersionIdPart())',
      );
      expect(
        tree.read(`${javaTestRoot}/telemetry/FhirRouteInterceptorTest.java`, 'utf-8'),
      ).toContain(
        'route(RestOperationTypeEnum.UPDATE, "Patient", "Patient/123/_history/2", null)',
      );
    });

    it('names request shapes and not resource types in routes', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);

      const interceptor = tree.read(`${javaRoot}/telemetry/FhirRouteInterceptor.java`, 'utf-8');
      expect(interceptor).toContain('route.append("/{type}")');
      expect(interceptor).toContain('bounded ? operation : "{operation}"');
      expect(interceptor).toContain('registeredOperations.contains(operation) || HAPI_TOKENS.contains(operation)');
      expect(interceptor).toContain('case BATCH -> "batch"');
      expect(tree.read(`${javaTestRoot}/telemetry/FhirRouteInterceptorTest.java`, 'utf-8')).toContain(
        '"/fhir/{type}/{operation}"',
      );
    });

    it('counts a request as unhandled only when HAPI rejected it before binding a handler', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);

      // HAPI's OpenApiInterceptor answers swagger-ui and api-docs before a handler is bound, so a
      // missing operation type alone cannot mean unhandled. The exception hook marks the rejections.
      const interceptor = tree.read(`${javaRoot}/telemetry/FhirRouteInterceptor.java`, 'utf-8');
      expect(interceptor).toContain('@Hook(value = Pointcut.SERVER_HANDLE_EXCEPTION, order = Integer.MIN_VALUE)');
      expect(interceptor).toContain('return isRejected(details) ? "unhandled" : OTHER;');
      expect(interceptor).toContain('return isRejected(details) ? UNHANDLED : OTHER_ROUTE;');
      expect(interceptor).toContain('details.getRestOperationType() != null && resourceType != null');
      const test = tree.read(`${javaTestRoot}/telemetry/FhirRouteInterceptorTest.java`, 'utf-8');
      expect(test).toContain('void rejectionBeforeHandlerCountsAsUnhandled()');
      expect(test).toContain('void answeredBeforeHandlerCountsAsOther()');
      expect(tree.read(docPath, 'utf-8')).toContain('| `/fhir/{type}/{id}` | Read, update, patch, and delete |');
    });

    it('sets a fixed log format when removing the parameters leaves a blank one', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);

      expect(tree.read(`${javaRoot}/TelemetryConfig.java`, 'utf-8')).toContain(
        'loggingInterceptor.setMessageFormat(format.isBlank() ? "${operationType} ${idOrResourceName}" : format);',
      );
    });

    it('adds the instrumentation-api dependency without a version', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);

      const pom = tree.read(pomPath, 'utf-8') as string;
      const dependency = /<dependency>(?:(?!<\/dependency>)[\s\S])*<\/dependency>/g;
      const inserted = pom
        .match(dependency)
        ?.find((element) =>
          element.includes('<artifactId>opentelemetry-instrumentation-api</artifactId>'),
        );
      expect(inserted).toContain('<groupId>io.opentelemetry.instrumentation</groupId>');
      expect(inserted).not.toContain('<version>');
      expect(pom.indexOf('opentelemetry-instrumentation-api')).toBeLessThan(
        pom.indexOf('<build>'),
      );
    });

    it('adds the opentelemetry-api dependency next to the instrumentation api', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);
      const pom = tree.read(pomPath, 'utf-8') as string;
      expect(pom).toContain('<artifactId>opentelemetry-api</artifactId>');
      expect(pom).not.toMatch(/<artifactId>opentelemetry-api<\/artifactId>\s*<version>/);
    });

    it('sets telemetry.capture-query-strings to false in application.yaml', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);

      const config = parseDocument(tree.read(yamlPath, 'utf-8') as string).toJS();
      expect(config.telemetry).toEqual({ 'capture-query-strings': false, 'resource-types': [] });
      expect(config.hapi.fhir.fhir_version).toBe('R4');
    });

    it('sets telemetry.resource-types to an empty list in application.yaml', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);
      const config = readYaml(tree, yamlPath);
      expect(config.telemetry).toEqual({ 'capture-query-strings': false, 'resource-types': [] });
    });

    it('writes OTEL.md at the project root', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);

      const doc = tree.read(docPath, 'utf-8');
      expect(doc).toContain('src/main/java/com/example/telemetry/FhirRouteInterceptor.java');
      expect(doc).toContain('telemetry.capture-query-strings');
      expect(doc).toContain('## Grafana dashboard');
      expect(doc).toContain('otel/grafana/dashboards/server.json');
      expect(doc).toContain('docker compose -f docker-compose.otel.yml up --build');
      expect(doc).toContain('the request log query-string filter stays active');
      expect(doc).toContain('nx serve server --otel');
      expect(doc).toContain('/otel-lgtm/dashboards:ro');
      expect(doc).toContain('## Request metric');
      expect(doc).toContain('fhir_server_requests_total');
      expect(doc).toContain('telemetry.resource-types');
      expect(doc).toContain('src/test/java/com/example/TelemetryConfigTest.java');
      expect(doc).toContain('## Series budget');
      expect(doc).toContain('otel_metric_overflow');
      expect(doc).toContain('`http.server.request.duration`');
      expect(doc).toContain('http_server_request_duration_seconds_bucket');
      expect(doc).toContain('Top requests (requests in range)');
      expect(doc).not.toContain('Error rate by status class');
      expect(doc).not.toContain('## Adding a part later');
      expect(doc).not.toMatch(/\n\n\n/);
    });

    it('renders only the sections of toggles that are on in OTEL.md', async () => {
      await otelFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
        dashboard: false,
        compose: false,
        serve: true,
      });

      const doc = tree.read(docPath, 'utf-8') as string;
      expect(doc).toContain('telemetry.capture-query-strings');
      expect(doc).toContain('## Request metric');
      expect(doc).toContain('## Series budget');
      expect(doc).not.toContain('## Grafana dashboard');
      expect(doc).not.toContain('## Local stack with Docker Compose');
      expect(doc).toContain('nx serve server --otel');
      expect(doc).not.toContain('/otel-lgtm/dashboards:ro');
      expect(doc).toContain('## Adding a part later');
      expect(doc).toContain('- Dashboard: copy `dashboard/grafana/`');
      expect(doc).toContain(
        '- Docker Compose: copy `compose/docker-compose.otel.yml.template` to the project root and `compose/otel/otelcol-filter.yaml.template` to `otel/`.\n',
      );
      expect(doc).not.toContain('- nx serve:');
      expect(doc).toContain('replace each `<%= name %>` placeholder');
      expect(doc).not.toMatch(/\n\n\n/);
    });

    it('writes CustomServerConfig when the server lacks wiring', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);

      expect(
        tree.read(
          'test-project/src/main/java/ca/uhn/fhir/jpa/starter/CustomServerConfig.java',
          'utf-8',
        ),
      ).toContain('@ComponentScan(basePackages = {"com.example"})');
    });

    it('throws naming every colliding file before writing', async () => {
      tree.write(`${javaRoot}/TelemetryConfig.java`, 'hand written');
      tree.write(`${javaTestRoot}/TelemetryConfigTest.java`, 'hand written');
      tree.write(docPath, 'hand written');
      const pomBefore = tree.read(pomPath, 'utf-8');

      const result = otelFeature.apply(
        tree,
        serverProject(tree),
        resolvedOptions,
      );

      await expect(result).rejects.toThrow(`${javaRoot}/TelemetryConfig.java`);
      await expect(result).rejects.toThrow(`${javaTestRoot}/TelemetryConfigTest.java`);
      await expect(result).rejects.toThrow(docPath);
      expect(tree.exists(`${javaRoot}/telemetry/FhirRouteInterceptor.java`)).toBe(false);
      expect(tree.read(pomPath, 'utf-8')).toBe(pomBefore);
    });
  });

  describe('toggles', () => {
    it.each([
      [true, false],
      [false, true],
      [false, false],
    ])(
      'writes agent.properties when compose or serve is on and not when both are off (compose %s, serve %s)',
      async (compose, serve) => {
        await otelFeature.apply(tree, serverProject(tree), {
          ...resolvedOptions,
          compose,
          serve,
        });

        expect(tree.exists(agentPropertiesPath)).toBe(compose || serve);
        expect(tree.exists(composePath)).toBe(compose);
        expect(tree.exists('test-project/otel/otelcol-filter.yaml')).toBe(compose);
        if (compose || serve) {
          const properties = tree.read(agentPropertiesPath, 'utf-8');
          expect(properties).toContain('otel.service.name=server\n');
          expect(properties).toContain('otel.instrumentation.common.default-enabled=false\n');
          expect(properties).toContain('otel.instrumentation.runtime-telemetry.enabled=true\n');
        }
      },
    );

    it('writes the dashboard and provisioning files named after serviceName', async () => {
      await otelFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
        serviceName: 'my-svc',
      });

      const dashboard = JSON.parse(tree.read(`${dashboardDir}/my-svc.json`, 'utf-8') as string);
      expect(dashboard.apiVersion).toBe('dashboard.grafana.app/v2');
      expect(dashboard.kind).toBe('Dashboard');
      expect(dashboard.metadata.name).toBe('my-svc');
      expect(dashboard.spec.title).toBe('my-svc');
      expect(dashboard.spec.tags).toEqual(['hapi', 'nx-fhir']);
      // The agent exports a cumulative counter every 60 s and starts a new series on every JVM
      // start. rate() and increase() never see a series' first sample, so every counter panel
      // uses the last_over_time delta with a zero baseline for series absent at the window start.
      for (const [id, title, window, instant, filters] of [
        ['panel-1', 'Requests per minute by interaction', '5m', false, []],
        ['panel-2', 'Error share by interaction', '5m', false, []],
        ['panel-21', 'Resource interactions', '$__range', true, ['fhir_resource_type!=""']],
        ['panel-22', 'Operations', '$__range', true, ['fhir_operation!=""']],
        ['panel-23', 'Average requests per minute, selected range', '$__range', true, []],
        ['panel-4', 'Top requests (requests in range)', '$__range', true, []],
        // The missing-label case passes a negative regex, so the Summary interaction count keeps
        // the fhir_interaction!="" matcher in front of the one that drops operations, rejected
        // requests, and requests an interceptor answered without a resource type.
        ['panel-24', 'Resource interactions, selected range', '$__range', true, ['fhir_interaction!~"operation|unhandled|other"']],
        ['panel-25', 'Operation invocations, selected range', '$__range', true, ['fhir_operation!=""']],
      ] as const) {
        const panel = dashboard.spec.elements[id].spec;
        expect(panel.title).toBe(title);
        const query = panel.data.spec.queries[0].spec.query.spec;
        // The SDK overflow series carries no fhir_interaction label, so the matcher keeps it out
        // of every sum.
        expect(query.expr).toContain('fhir_server_requests_total{service_name=~"$service", fhir_interaction!=""');
        expect(query.expr).not.toContain('http_server_request_duration');
        expect(query.expr).toContain('last_over_time(');
        expect(query.expr).toContain(`offset ${window}`);
        expect(query.expr).not.toMatch(/\b(rate|increase)\(/);
        expect(query.instant ?? false).toBe(instant);
        // The delta subtracts the offset and zero-baseline terms from the current term by label
        // set, so a filter that differs between the three selectors of a metric can drop rows
        // without an error.
        const selectors: string[] = query.expr.match(/fhir_server_(?:requests|errors)_total\{[^}]*\}/g) ?? [];
        const metrics = [...new Set(selectors.map((selector) => selector.slice(0, selector.indexOf('{'))))];
        expect(selectors).toHaveLength(3 * metrics.length);
        for (const metric of metrics) {
          const own = selectors.filter((selector) => selector.startsWith(`${metric}{`));
          expect(own).toEqual(Array(3).fill(own[0]));
          for (const filter of ['fhir_interaction!=""', ...filters]) {
            expect(own[0]).toContain(filter);
          }
        }
      }
      const errorShare = dashboard.spec.elements['panel-2'].spec;
      const [errorTerm, requestTerm] = errorShare.data.spec.queries[0].spec.query.spec.expr.split('\n / ');
      expect(errorTerm).toMatch(/^sum by \(fhir_interaction\) \(\nlast_over_time\(fhir_server_errors_total\{/);
      expect(errorTerm).not.toContain('fhir_server_requests_total');
      expect(requestTerm).toMatch(/^sum by \(fhir_interaction\) \(\nlast_over_time\(fhir_server_requests_total\{/);
      expect(requestTerm).not.toContain('fhir_server_errors_total');
      expect(errorShare.vizConfig.spec.fieldConfig.defaults).toMatchObject({ unit: 'percentunit', min: 0, max: 1 });
      // A series keeps exporting after its last request, so a zero delta is real data. The range
      // panels drop it so an idle series does not show as a 0 bar or row.
      for (const id of ['panel-21', 'panel-22', 'panel-4']) {
        expect(dashboard.spec.elements[id].spec.data.spec.queries[0].spec.query.spec.expr).toContain(') > 0');
      }
      const exprOf = (id: string): string =>
        dashboard.spec.elements[id].spec.data.spec.queries[0].spec.query.spec.expr;
      expect(exprOf('panel-21')).toContain('fhir_resource_type!=""');
      expect(exprOf('panel-21')).toContain('sum by (fhir_resource_type)');
      expect(exprOf('panel-22')).toContain('fhir_operation!=""');
      expect(exprOf('panel-22')).toContain('sum by (fhir_operation)');
      expect(exprOf('panel-4')).toContain('sum by (fhir_resource_type, fhir_interaction, fhir_operation)');
      expect(
        dashboard.spec.elements['panel-4'].spec.data.spec.transformations[0].spec.options.renameByName,
      ).toEqual({
        fhir_resource_type: 'Resource',
        fhir_interaction: 'Interaction',
        fhir_operation: 'Operation',
        Value: 'Requests',
      });
      expect(dashboard.spec.elements['panel-23'].spec.data.spec.queries[0].spec.query.spec.expr).toMatch(
        /\) \/ \(\$__range_s \/ 60\) or vector\(0\)$/,
      );
      // Every panel is evaluated at a step of at least one export interval (60 s), so a step never
      // lands between two exports and reads the same sample twice.
      for (const element of Object.values<{ kind: string; spec: { data: { spec: { queryOptions: { interval: string } } } } }>(
        dashboard.spec.elements,
      )) {
        if (element.kind === 'Panel') {
          expect(element.spec.data.spec.queryOptions.interval).toBe('1m');
        }
      }
      for (const id of ['panel-23', 'panel-24', 'panel-25', 'panel-26', 'panel-27']) {
        expect(dashboard.spec.elements[id].spec.vizConfig.group).toBe('stat');
      }
      // The short unit shows 1613 as "2 K", so the count stats use none and show the whole number.
      for (const id of ['panel-24', 'panel-25', 'panel-27']) {
        expect(dashboard.spec.elements[id].spec.vizConfig.spec.fieldConfig.defaults).toMatchObject({ unit: 'none', decimals: 0 });
      }
      for (const id of ['panel-24', 'panel-25']) {
        expect(exprOf(id)).toMatch(/\) or vector\(0\)$/);
      }
      // The gauge holds the JVM start as epoch seconds, and Grafana date units take milliseconds.
      expect(exprOf('panel-26')).toBe('max(fhir_server_start_time_seconds{service_name=~"$service"}) * 1000');
      expect(dashboard.spec.elements['panel-26'].spec.title).toBe('Last server start');
      expect(dashboard.spec.elements['panel-26'].spec.vizConfig.spec.fieldConfig.defaults.unit).toBe('dateTimeAsLocal');
      // Each JVM start is a new series, so starts in range are the series whose start time is at
      // or after the range start, and an idle range reads 0 instead of no data.
      expect(exprOf('panel-27')).toBe(
        'count(min_over_time(fhir_server_start_time_seconds{service_name=~"$service"}[$__range]) >= time() - $__range_s) or vector(0)',
      );
      expect(dashboard.spec.elements['panel-27'].spec.title).toBe('Server starts, selected range');
      // The counter records a path HAPI rejected only as the unhandled interaction. The breakdown
      // comes from the url.path of spans with the /fhir/unhandled route. Tempo quotes label values and
      // has no sort stage, so the panel renames, reduces series to rows, sorts, and turns the rows
      // back into fields for the bar gauge.
      const tracePaths = dashboard.spec.elements['panel-6'].spec;
      expect(tracePaths.title).toBe('Unhandled request paths (traces)');
      expect(tracePaths.data.spec.queries[0].spec.query.group).toBe('tempo');
      expect(tracePaths.data.spec.queries[0].spec.query.datasource.name).toBe('${tempo}');
      expect(tracePaths.data.spec.queries[0].spec.query.spec.query).toContain('span.http.route = "/fhir/unhandled"');
      expect(tracePaths.data.spec.queries[0].spec.query.spec.query).toContain('resource.service.name = "$service"');
      expect(tracePaths.data.spec.queries[0].spec.query.spec.query).toMatch(/\| topk\(10\)$/);
      expect(tracePaths.data.spec.queries[0].spec.query.spec.metricsQueryType).toBe('instant');
      expect(tracePaths.data.spec.transformations.map((tx: { group: string }) => tx.group)).toEqual([
        'renameByRegex',
        'reduce',
        'sortBy',
        'rowsToFields',
      ]);
      expect(tracePaths.vizConfig.spec.fieldConfig.defaults.displayName).toBe('${__field.name}');
      const latency = dashboard.spec.elements['panel-7'].spec;
      expect(latency.title).toBe('Average processing time by route (traces)');
      expect(latency.data.spec.queries[0].spec.query.datasource.name).toBe('${tempo}');
      expect(latency.data.spec.queries[0].spec.query.spec.query).toBe(
        '{ resource.service.name = "$service" && kind = server } | avg_over_time(duration) by (span.http.route)',
      );
      expect(latency.data.spec.queries[0].spec.query.spec.metricsQueryType).toBe('range');
      // Bursty traffic leaves sub-minute steps empty, so the query steps by minute and the line bridges one missed step.
      expect(latency.data.spec.queries[0].spec.query.spec.step).toBe('1m');
      expect(latency.vizConfig.spec.fieldConfig.defaults.custom.spanNulls).toBe(120000);
      expect(latency.vizConfig.group).toBe('timeseries');
      expect(latency.vizConfig.spec.fieldConfig.defaults.unit).toBe('s');
      const cpu = dashboard.spec.elements['panel-8'].spec;
      expect(cpu.title).toBe('CPU usage');
      expect(cpu.data.spec.queries[0].spec.query.datasource.name).toBe('${prometheus}');
      expect(cpu.data.spec.queries[0].spec.query.spec.expr).toBe(
        'max by (service_name) (jvm_cpu_recent_utilization_ratio{service_name=~"$service"})',
      );
      expect(cpu.vizConfig.group).toBe('timeseries');
      expect(cpu.vizConfig.spec.fieldConfig.defaults.unit).toBe('percentunit');
      // The gauge is the share of the machine, so a near-idle JVM would otherwise autoscale the axis past 100%.
      expect(cpu.vizConfig.spec.fieldConfig.defaults.max).toBe(1);
      const memory = dashboard.spec.elements['panel-9'].spec;
      expect(memory.title).toBe('Memory usage');
      expect(memory.data.spec.queries[0].spec.query.spec.expr).toBe(
        'sum by (jvm_memory_type) (jvm_memory_used_bytes{service_name=~"$service"})',
      );
      expect(memory.vizConfig.spec.fieldConfig.defaults.unit).toBe('bytes');
      expect(memory.data.spec.queries[1].spec.query.spec.expr).toBe(
        'sum(jvm_memory_used_bytes{service_name=~"$service", jvm_memory_type="heap"}) / max(jvm_memory_limit_bytes{service_name=~"$service", jvm_memory_type="heap"})',
      );
      expect(memory.data.spec.queries.map((q: { spec: { refId: string } }) => q.spec.refId)).toEqual(['A', 'B']);
      const share = memory.vizConfig.spec.fieldConfig.overrides[0];
      expect(share.matcher.options).toBe('heap, share of limit');
      expect(share.properties).toContainEqual({ id: 'unit', value: 'percentunit' });
      expect(share.properties).toContainEqual({ id: 'custom.axisPlacement', value: 'right' });
      expect(dashboard.spec.variables.map((v: { spec: { name: string } }) => v.spec.name)).toEqual([
        'prometheus',
        'loki',
        'tempo',
        'service',
      ]);
      expect(
        dashboard.spec.variables.find((v: { spec: { name: string } }) => v.spec.name === 'service').spec.query.spec
          .query,
      ).toBe('label_values(fhir_server_requests_total, service_name)');
      type Item = { spec: { x: number; y: number; width: number; height: number; element: { name: string } } };
      const rows: { spec: { title: string; layout: { spec: { items: Item[] } } } }[] = dashboard.spec.layout.spec.rows;
      expect(rows.map((row) => row.spec.title)).toEqual(['Summary', 'Traffic', 'Runtime']);
      const summary = rows[0].spec.layout.spec.items;
      const summaryItemOf = (name: string) => summary.find((item) => item.spec.element.name === name)?.spec;
      expect(summaryItemOf('panel-24')).toMatchObject({ x: 0, y: 0, width: 6, height: 4 });
      expect(summaryItemOf('panel-25')).toMatchObject({ x: 6, y: 0, width: 6, height: 4 });
      expect(summaryItemOf('panel-26')).toMatchObject({ x: 12, y: 0, width: 6, height: 4 });
      expect(summaryItemOf('panel-27')).toMatchObject({ x: 18, y: 0, width: 6, height: 4 });
      const items = rows[1].spec.layout.spec.items;
      const itemOf = (name: string) => items.find((item) => item.spec.element.name === name)?.spec;
      expect(itemOf('panel-1')).toMatchObject({ x: 0, y: 8, width: 12, height: 8 });
      expect(itemOf('panel-2')).toMatchObject({ x: 12, y: 8, width: 12, height: 8 });
      expect(itemOf('panel-7')).toMatchObject({ x: 0, y: 24, width: 24, height: 8 });
      expect(itemOf('panel-6')).toMatchObject({ x: 0, y: 32, width: 24, height: 8 });
      const runtime = rows[2].spec.layout.spec.items;
      const runtimeItemOf = (name: string) => runtime.find((item) => item.spec.element.name === name)?.spec;
      expect(runtimeItemOf('panel-8')).toMatchObject({ x: 0, y: 0, width: 12, height: 8 });
      expect(runtimeItemOf('panel-9')).toMatchObject({ x: 12, y: 0, width: 12, height: 8 });
      const placed = rows.flatMap((row) => row.spec.layout.spec.items.map((item) => item.spec.element.name));
      expect(placed.sort()).toEqual(Object.keys(dashboard.spec.elements).sort());

      const provisioning = readYaml(tree, `${provisioningDir}/my-svc.yaml`);
      expect(provisioning.providers[0].name).toBe('my-svc');
      expect(provisioning.providers[0].folder).toBe('my-svc');
      expect(provisioning.providers[0].allowUiUpdates).toBe(true);
      expect(provisioning.providers[0].options.path).toBe('/otel-lgtm/dashboards');
    });

    it('skips the dashboard files when dashboard is false', async () => {
      await otelFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
        dashboard: false,
      });

      expect(tree.exists(`${dashboardDir}/server.json`)).toBe(false);
      expect(tree.exists(`${provisioningDir}/server.yaml`)).toBe(false);
      expect(tree.exists(agentPropertiesPath)).toBe(true);
    });

    it('writes a compose file with both services and the dashboard mounts', async () => {
      await otelFeature.apply(tree, serverProject(tree), resolvedOptions);

      const { services } = readYaml(tree, composePath);
      expect(services.server.build.context).toBe('.');
      expect(services.server.build.args.OPENTELEMETRY_JAVA_AGENT_VERSION).toBe('2.32.0');
      expect(services.server.environment.OTEL_JAVAAGENT_CONFIGURATION_FILE).toBe(
        '/app/otel/agent.properties',
      );
      expect(services.server.environment.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
        'http://otel-lgtm:4318',
      );
      expect(services.server.volumes).toEqual([
        './otel/agent.properties:/app/otel/agent.properties:ro',
      ]);
      expect(services.server.depends_on).toEqual(['otel-lgtm']);
      expect(services['otel-lgtm'].volumes).toEqual([
        './otel/grafana/dashboards:/otel-lgtm/dashboards:ro',
        './otel/grafana/provisioning/dashboards:/otel-lgtm/grafana/conf/provisioning/dashboards:ro',
      ]);
      expect(services['otel-lgtm'].environment).toBeUndefined();
      const compose = tree.read(composePath, 'utf-8') as string;
      expect(compose).toContain('    #   OTELCOL_EXTRA_ARGS: --config=file:/otel-lgtm/otelcol-filter.yaml\n');
      expect(compose).toContain('      # - ./otel/otelcol-filter.yaml:/otel-lgtm/otelcol-filter.yaml:ro\n');
      expect(compose).not.toMatch(/\n\n$/);
      const filter = tree.read('test-project/otel/otelcol-filter.yaml', 'utf-8') as string;
      expect(filter).toContain(`- 'name == "http.server.request.duration"'`);
      expect(filter).toContain('processors: [filter/histogram, batch]');
    });

    it('writes the compose file without dashboard mounts when dashboard is false', async () => {
      await otelFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
        dashboard: false,
      });

      const compose = tree.read(composePath, 'utf-8') as string;
      const { services } = readYaml(tree, composePath);
      expect(services['otel-lgtm'].volumes).toBeUndefined();
      expect(services['otel-lgtm'].ports).toHaveLength(3);
      expect(compose).toContain('    # volumes:\n    #   - ./otel/otelcol-filter.yaml:/otel-lgtm/otelcol-filter.yaml:ro\n');
      expect(compose).not.toMatch(/\n\n$/);
    });

    it('renders the compose build arg from OTEL_JAVAAGENT_VERSION', async () => {
      vi.resetModules();
      vi.doMock('../../shared/constants/versions', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../shared/constants/versions')>()),
        OTEL_JAVAAGENT_VERSION: '9.9.9',
      }));
      try {
        const { otelFeature: feature } = await import('./otel');
        await feature.apply(tree, serverProject(tree), resolvedOptions);
      } finally {
        vi.doUnmock('../../shared/constants/versions');
      }

      const { services } = readYaml(tree, composePath);
      expect(services.server.build.args.OPENTELEMETRY_JAVA_AGENT_VERSION).toBe('9.9.9');
      const doc = tree.read(docPath, 'utf-8') as string;
      expect(doc).toContain('pins the agent to 9.9.9.');
      expect(doc).toContain('OpenTelemetry Java agent 9.9.9 to');
    });

    it('throws before writing when docker-compose.otel.yml already exists', async () => {
      tree.write(composePath, 'hand written');
      const pomBefore = tree.read(pomPath, 'utf-8');

      await expect(
        otelFeature.apply(tree, serverProject(tree), resolvedOptions),
      ).rejects.toThrow(composePath);
      expect(tree.exists(`${javaRoot}/TelemetryConfig.java`)).toBe(false);
      expect(tree.exists(agentPropertiesPath)).toBe(false);
      expect(tree.read(composePath, 'utf-8')).toBe('hand written');
      expect(tree.read(pomPath, 'utf-8')).toBe(pomBefore);
    });

    it('throws before writing when the dashboard file already exists', async () => {
      tree.write(`${dashboardDir}/server.json`, '{}');

      await expect(
        otelFeature.apply(tree, serverProject(tree), resolvedOptions),
      ).rejects.toThrow(`${dashboardDir}/server.json`);
      expect(tree.exists(`${javaRoot}/TelemetryConfig.java`)).toBe(false);
    });
  });

  describe('through runFeature', () => {
    it('records the resolved options in the project manifest', async () => {
      await runFeature(
        tree,
        { feature: 'otel', project: 'server' },
        [otelFeature],
      );

      expect(serverProject(tree).features).toEqual({
        otel: { version: 1, options: resolvedOptions },
      });
    });

    it('rejects a server below HAPI 8.0.0', async () => {
      tree = createServerTree('7.6.0');

      await expect(
        runFeature(
          tree,
          { feature: 'otel', project: 'server' },
          [otelFeature],
        ),
      ).rejects.toThrow(/8\.0\.0 and later/);
    });
  });
});
