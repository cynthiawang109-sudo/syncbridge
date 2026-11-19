const { DB_USER, DB_PASSWORD, DB_HOST, DB_PORT } = process.env;
if (!DB_USER || !DB_PASSWORD || !DB_HOST || !DB_PORT) {
  throw new Error("Missing database connection configuration");
}
const url = new URL("postgresql://" + DB_HOST + ":" + DB_PORT + "/syncbridge");
url.username = DB_USER;
url.password = DB_PASSWORD;
url.searchParams.set("sslmode", "require");
process.stdout.write(url.href);
