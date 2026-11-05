import { createRequire } from "node:module";

// Process-local integration test guard. Any accidental legacy SQL parsing in
// this worker fails; the SQLite demonstration is tested in other processes.
const require = createRequire(import.meta.url);
const { Parser } = require("node-sql-parser");
Parser.prototype.astify = function forbiddenLegacyParser() { throw new Error("test_sqlite_parser_forbidden"); };
