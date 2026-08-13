interface SqlRows extends Array<Record<string, unknown>> {
  readonly affectedRows: number | null;
}

interface SqlClient {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRows>;
}

declare const Bun: {
  readonly argv: string[];
  readonly env: Record<string, string | undefined>;
  readonly main: string;
  readonly SQL: new (url: string, options?: { max?: number }) => SqlClient;
  readonly Glob: new (pattern: string) => {
    scan(cwd: string): AsyncIterable<string>;
  };
  exit(code?: number): never;
  file(path: string): Blob & { exists(): Promise<boolean> };
  spawn(command: string[], options: {
    env?: Record<string, string | undefined>;
    stdin?: "inherit";
    stdout?: "inherit";
    stderr?: "inherit";
  }): { readonly exited: Promise<number> };
  serve(options: {
    port: number;
    development?: boolean;
    maxRequestBodySize?: number;
    fetch(request: Request): Response | Promise<Response>;
  }): {
    readonly url: URL;
  };
};
