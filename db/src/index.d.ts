import Database from "better-sqlite3";
export type Db = Database.Database;
export declare function openDb(path: string): Db;
export declare function getDb(): Db;
export declare function closeDb(): void;
//# sourceMappingURL=index.d.ts.map