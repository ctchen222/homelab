declare module "node:child_process" {
  export function execFileSync(command: string, args?: string[], options?: any): any;
}

declare module "node:crypto" {
  export function timingSafeEqual(a: any, b: any): boolean;
  export interface Hash {
    update(input: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: any): void;
  export function readFileSync(path: string, encoding?: any): any;
  export function unlinkSync(path: string): void;
  export function writeFileSync(path: string, data: any, options?: any): void;
}

declare module "node:http" {
  export function createServer(handler: any): any;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
  on(event: string, listener: (...args: any[]) => void): void;
};

declare const Buffer: {
  concat(chunks: any[]): any;
  from(input: any): any;
};
