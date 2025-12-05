export interface UpdateServerGeneratorSchema {
  project?: string;
  targetVersion?: string;
  force?: boolean;
  /** Internal: Set when called from nx migrate (ignores expected migrate file changes) */
  fromNxMigrate?: boolean;
}
