CREATE TABLE metric_buckets (
  connection_id TEXT NOT NULL REFERENCES connections(id),
  minute TIMESTAMP(3) NOT NULL,
  kind TEXT NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  total DOUBLE PRECISION NOT NULL DEFAULT 0,
  peak DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, minute, kind)
);
CREATE INDEX metric_buckets_minute_idx ON metric_buckets (minute);
