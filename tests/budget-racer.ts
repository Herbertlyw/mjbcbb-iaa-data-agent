import { MysqlStateStore } from "../src/mysql-state-store.js";

const connection = JSON.parse(process.argv[2] ?? "{}") as {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};
const input = JSON.parse(process.argv[3] ?? "{}");
const store = new MysqlStateStore(connection);
try {
  console.log(JSON.stringify(store.beginProviderStep(input)));
} finally {
  store.close();
}
