import {
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_alphanumericCaseSensitive,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  sortFn_textCaseSensitive,
  tableFeatures,
} from "@tanstack/react-table";

/**
 * Shared TanStack Table v9 feature set for the DataTable component.
 * Registered once at module scope (features must be a stable reference) and
 * shared with every ColumnDef consumer so their TFeatures generic matches
 * the table instance built in DataTable.
 *
 * Includes all six built-in sort functions so auto-detected sorting behaves
 * the same as v8's default sortingFns across every column data type.
 */
export const dataTableFeatures = tableFeatures({
  columnVisibilityFeature,
  columnSizingFeature,
  columnResizingFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    alphanumericCaseSensitive: sortFn_alphanumericCaseSensitive,
    text: sortFn_text,
    textCaseSensitive: sortFn_textCaseSensitive,
    datetime: sortFn_datetime,
    basic: sortFn_basic,
  },
});
