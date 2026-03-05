export interface FrontendGeneratorSchema {
  name: string;
  server?: string;
  template?: 'browser' | 'clinical';
  navigationLayout?: 'sidebar' | 'topnav';
}
