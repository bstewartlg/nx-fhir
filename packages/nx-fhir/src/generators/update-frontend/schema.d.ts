export interface UpdateFrontendGeneratorSchema {
  project?: string;
  targetVersion?: string;
  force?: boolean;
  /** Keep a frontend update without asking, even when it has risky dependency changes or failing checks */
  acceptBreaking?: boolean;
  /** Internal: Set when called from nx migrate (ignores expected migrate file changes) */
  fromNxMigrate?: boolean;
}
