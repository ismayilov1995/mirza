/**
 * Minimal declarations for node:sqlite.
 *
 * Node 24 ships the module (verified at runtime) but @types/node ^20, which
 * this project pins, does not describe it. Declaring only what
 * scripts/import-archive.ts uses is preferable to loosening the pin: the type
 * package is shared by every file here, and the archive importer is one.
 */
declare module "node:sqlite" {
  export class StatementSync {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
