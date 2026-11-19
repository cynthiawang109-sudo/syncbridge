process.env.DATABASE_URL ??=
  "postgresql://syncbridge:syncbridge@127.0.0.1:45432/syncbridge";
process.env.ENVELOPE_KEY ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.REDIS_PORT ??= "46379";
process.env.DYNAMODB_URL ??= "http://127.0.0.1:4800";
