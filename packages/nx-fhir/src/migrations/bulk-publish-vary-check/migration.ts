import { getProjects, joinPathFragments, logger, Tree } from '@nx/devkit';
import { ServerProjectConfiguration } from '../../shared/models';

const HELPER_NAME = 'assertVaryNamesAcceptEncodingAndAccept';
const ARRAY_LIST_IMPORT = 'import java.util.ArrayList;';
const ARRAYS_IMPORT = 'import java.util.Arrays;';

const VARY_ASSERTION =
  /^\t\tassertEquals\((\r?\n)\t\t\t\t"Accept-Encoding, Accept",\r?\n\t\t\t\t(\w+)\.headers\(\)\.firstValue\("Vary"\)\.orElse\(null\),\r?\n\t\t\t\t("[^"\r\n]*")\);/gm;

// Copies the helper of BulkPublishIT.java.template, so a repaired file and a file from the feature generator have the same helper.
const HELPER_LINES = [
  '',
  '\t/** A CORS mapping can add its own Vary header or name, so the check reads every Vary value. */',
  '\tprivate static void assertVaryNamesAcceptEncodingAndAccept(HttpResponse<?> response, String message) {',
  '\t\tList<String> names = response.headers().allValues("Vary").stream()',
  '\t\t\t\t.flatMap(value -> Arrays.stream(value.split(",")))',
  '\t\t\t\t.map(String::trim)',
  '\t\t\t\t.toList();',
  '\t\tassertTrue(names.containsAll(List.of("Accept-Encoding", "Accept")), message);',
  '\t}',
  '',
];

/**
 * The bulk-publish feature of releases 0.3.0 to 0.3.2 writes a BulkPublishIT.java whose
 * Vary assertions read only the first Vary header. A CORS mapping can add its own Vary
 * header first, and the assertions then fail. Feature files have no update path, so this
 * migration edits the file in place.
 *
 * The migration changes only the assertions that keep the exact layout of the feature
 * template. A file with none of them, or with neither the java.util.ArrayList nor the
 * java.util.Arrays import line, has changes from its owner and stays as it is.
 */
export default function bulkPublishVaryCheck(tree: Tree): void {
  for (const config of getProjects(tree).values()) {
    const project = config as ServerProjectConfiguration;
    if (!project.fhirVersion || !project.packageBase || !project.features?.['bulk-publish']) {
      continue;
    }
    const file = joinPathFragments(
      project.root,
      'src/test/java',
      project.packageBase.replace(/\./g, '/'),
      'publish/BulkPublishIT.java',
    );
    const content = tree.read(file, 'utf-8');
    if (!content || content.includes(HELPER_NAME)) {
      continue;
    }
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    let updated = content.replace(VARY_ASSERTION, `\t\t${HELPER_NAME}($1\t\t\t\t$2, $3);`);
    if (!updated.includes(ARRAYS_IMPORT)) {
      updated = updated.replace(
        `${ARRAY_LIST_IMPORT}${eol}`,
        `${ARRAY_LIST_IMPORT}${eol}${ARRAYS_IMPORT}${eol}`,
      );
    }
    if (!updated.includes(HELPER_NAME) || !updated.includes(ARRAYS_IMPORT)) {
      continue;
    }
    const classEnd = updated.lastIndexOf('}');
    tree.write(file, updated.slice(0, classEnd) + HELPER_LINES.join(eol) + updated.slice(classEnd));
    logger.info(`Updated the Vary assertions in ${file}`);
  }
}
