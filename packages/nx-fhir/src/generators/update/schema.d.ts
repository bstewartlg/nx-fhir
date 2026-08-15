export interface UpdateGeneratorSchema {
  /** Force update and override safety checks (e.g., uncommitted files warning) */
  force?: boolean;
  /** Internal: Set when called from nx migrate (ignores expected migrate file changes) */
  fromNxMigrate?: boolean;
}
