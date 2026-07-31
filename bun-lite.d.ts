type BunBinaryData =
  | string
  | ArrayBuffer
  | SharedArrayBuffer
  | ArrayBufferView
  | Blob
  | Response
  | Request;

type ProcessLike = {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32";
  exit(code?: number): never;
  title: string;
};

interface ImportMetaEnv {
  readonly MODE: string;
  readonly BASE_URL?: string;
  readonly DEV?: boolean;
  readonly PROD?: boolean;
  readonly SSR?: boolean;
  readonly [key: string]: string | boolean | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface WorkerOptions {
  /** Use Bun's smaller JavaScriptCore heap profile. This is not a hard memory limit. */
  smol?: boolean;
}

declare const process: ProcessLike;

declare namespace Bun {
    interface BunFile extends Blob {
      readonly lastModified: number;
      readonly name: string;
      readonly type: string;
      exists(): Promise<boolean>;
      slice(start?: number, end?: number, contentType?: string): Blob;
      stream(): ReadableStream<Uint8Array>;
      text(): Promise<string>;
      json<T = unknown>(): Promise<T>;
      arrayBuffer(): Promise<ArrayBuffer>;
    }

    interface Password {
      hash(password: string | ArrayBufferView | ArrayBuffer): Promise<string>;
      verify(
        password: string | ArrayBufferView | ArrayBuffer,
        hash: string,
      ): Promise<boolean>;
    }

    type HashData =
      | string
      | ArrayBufferView
      | ArrayBuffer
      | SharedArrayBuffer;

    /** Non-cryptographic hashing functions. */
    interface Hash {
      (data: HashData, seed?: number | bigint): number | bigint;
      wyhash(data: HashData, seed?: bigint): bigint;
      adler32(data: HashData): number;
      crc32(data: HashData, seed?: number): number;
      cityHash32(data: HashData): number;
      cityHash64(data: HashData, seed?: bigint): bigint;
      xxHash32(data: HashData, seed?: number): number;
      xxHash64(data: HashData, seed?: bigint): bigint;
      xxHash3(data: HashData, seed?: bigint): bigint;
      murmur32v2(data: HashData, seed?: number): number;
      murmur32v3(data: HashData, seed?: number): number;
      murmur64v2(data: HashData, seed?: bigint): bigint;
      rapidhash(data: HashData, seed?: bigint): bigint;
    }

    interface ServerWebSocket<Data = unknown> extends WebSocket {
      readonly data: Data;
      publish(topic: string, data: BunBinaryData, compress?: boolean): number;
      subscribe(topic: string): void;
      unsubscribe(topic: string): void;
      send(data: string | ArrayBufferView | ArrayBuffer | Blob): number;
      close(code?: number, reason?: string): void;
    }

    interface WebSocketHandler<Data = unknown> {
      open?(ws: ServerWebSocket<Data>): void | Promise<void>;
      message?(
        ws: ServerWebSocket<Data>,
        message: string | Uint8Array,
      ): void | Promise<void>;
      close?(
        ws: ServerWebSocket<Data>,
        code: number,
        reason: string,
      ): void | Promise<void>;
      drain?(ws: ServerWebSocket<Data>): void | Promise<void>;
      error?(ws: ServerWebSocket<Data>, error: Error): void | Promise<void>;
    }

    interface ServeOptions<Data = unknown> {
      port?: number | string;
      hostname?: string;
      development?: boolean;
      idleTimeout?: number;
      routes?: Record<string, unknown>;
      fetch(
        request: Request,
        server: Server<Data>,
      ): Response | Promise<Response>;
      error?(error: Error): Response | Promise<Response>;
      websocket?: WebSocketHandler<Data>;
    }

    interface Server<Data = unknown> {
      readonly hostname: string;
      readonly port: number;
      readonly url: URL;
      stop(closeActiveConnections?: boolean): void;
      publish(topic: string, data: BunBinaryData, compress?: boolean): number;
      upgrade(
        request: Request,
        options?: {
          data?: Data;
          headers?: HeadersInit;
        },
      ): boolean;
    }

    interface BunGlobal {
      readonly argv: string[];
      readonly env: Record<string, string | undefined>;
      readonly password: Password;
      readonly hash: Hash;
      file(
        path: string | URL | ArrayBufferLike | Uint8Array,
        options?: { type?: string },
      ): BunFile;
      write(
        destination: string | URL | BunFile,
        data: BunBinaryData,
      ): Promise<number>;
      serve<Data = unknown>(options: ServeOptions<Data>): Server<Data>;
      sleep(ms: number): Promise<void>;
      which(
        executable: string,
        options?: { PATH?: string; cwd?: string },
      ): string | null;
      spawn(options: {
        cmd: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdout?: "pipe" | "inherit" | "ignore";
        stderr?: "pipe" | "inherit" | "ignore";
        stdin?: "pipe" | "inherit" | "ignore";
      }): {
        stdout: ReadableStream<Uint8Array> | null;
        stderr: ReadableStream<Uint8Array> | null;
        stdin: WritableStream<Uint8Array> | null;
        pid: number;
        exitCode: number | null;
      };
      spawnSync(options: {
        cmd: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdout?: "pipe" | "inherit" | "ignore";
        stderr?: "pipe" | "inherit" | "ignore";
        stdin?: "pipe" | "inherit" | "ignore";
      }): {
        stdout: Uint8Array | null;
        stderr: Uint8Array | null;
        pid: number;
        exitCode: number;
      };
    }
}

declare const Bun: Bun.BunGlobal;

declare module "*.html" {
  const value: unknown;
  export default value;
}

declare module "*.png" {
  const path: string;
  export default path;
}

declare module "node:fs" {
  export function mkdirSync(
    path: string | URL,
    options?: { recursive?: boolean },
  ): string | undefined;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
}

declare module "bun" {
  export const argv: typeof Bun.argv;
  export const env: typeof Bun.env;
  export const password: typeof Bun.password;
  export const hash: typeof Bun.hash;
  export const file: typeof Bun.file;
  export const write: typeof Bun.write;
  export const serve: typeof Bun.serve;
  export const sleep: typeof Bun.sleep;
  export const which: typeof Bun.which;
  export default Bun;
}

declare module "bun:sqlite" {
  export type SQLValue =
    | string
    | number
    | bigint
    | boolean
    | Uint8Array
    | null;

  export type StatementBinding = SQLValue | Record<string, SQLValue>;

  export interface Statement<Row = unknown> {
    all(...bindings: StatementBinding[]): Row[];
    get(...bindings: StatementBinding[]): Row | null;
    run(...bindings: StatementBinding[]): Database;
    values(...bindings: StatementBinding[]): SQLValue[][];
    iterate(...bindings: StatementBinding[]): IterableIterator<Row>;
    finalize(): void;
    as<T>(): Statement<T>;
  }

  export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    strict?: boolean;
    safeIntegers?: boolean;
  }

  export class Database {
    constructor(filename?: string, options?: DatabaseOptions);
    readonly inTransaction: boolean;
    close(): void;
    exec(sql: string): void;
    prepare<Row = unknown>(sql: string): Statement<Row>;
    query<Row = unknown>(sql: string): Statement<Row>;
    run(sql: string, ...bindings: StatementBinding[]): this;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
  }

  export default Database;
}

declare module "fs/promises" {
  export function readFile(path: string | URL): Promise<Uint8Array>;
  export function readFile(
    path: string | URL,
    encoding: "utf-8" | "utf8",
  ): Promise<string>;
  export function writeFile(
    path: string | URL,
    data: string | ArrayBuffer | ArrayBufferView | Blob,
    encoding?: "utf-8" | "utf8",
  ): Promise<void>;
  export function rm(
    path: string | URL,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
  export function mkdir(
    path: string | URL,
    options?: { recursive?: boolean },
  ): Promise<string | undefined>;
  export function readdir(path: string | URL): Promise<string[]>;
  // export function isdir(path: string | URL): Promise<boolean>;


  export function stat(path: string | URL): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtimeMs: number;
  }>;

}

declare module "process" {
  export const argv: ProcessLike["argv"];
  export const env: ProcessLike["env"];
  export let title: ProcessLike["title"];
  export function exit(code?: number): never;

  const processModule: ProcessLike;
  export default processModule;
}
