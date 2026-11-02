import { AsyncMysqlStateStore } from "../src/async-mysql-state-store.js";

const connection = JSON.parse(process.argv[2] ?? "{}") as {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};
const input = JSON.parse(process.argv[3] ?? "{}");
const store = await AsyncMysqlStateStore.open(connection);
try {
  console.log(JSON.stringify(await store.call("beginProviderStep", input)));
} finally {
  await store.close();
}
