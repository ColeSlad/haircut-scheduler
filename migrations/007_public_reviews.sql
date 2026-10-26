CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL UNIQUE NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 600),
  stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  sample BOOLEAN NOT NULL DEFAULT FALSE,
  show_on_home BOOLEAN NOT NULL DEFAULT FALSE,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT,
  version INTEGER NOT NULL DEFAULT 1,
  request_hash TEXT UNIQUE,
  request_fingerprint TEXT,
  CHECK(NOT (hidden AND show_on_home))
);
INSERT INTO reviews (id, name, text, stars, sample, show_on_home, position)
SELECT COALESCE(NULLIF(item->>'id', ''), 'legacy-review-' || ordinal), item->>'name', item->>'text',
  (item->>'stars')::integer, COALESCE((item->>'sample')::boolean, FALSE), ordinal <= 3, ordinal::integer
FROM review_content, jsonb_array_elements(value::jsonb->'items') WITH ORDINALITY AS source(item, ordinal)
WHERE review_content.id = 1
ORDER BY ordinal DESC;
CREATE INDEX reviews_public ON reviews(seq DESC) WHERE NOT hidden;
CREATE INDEX reviews_home ON reviews(position, seq DESC) WHERE show_on_home AND NOT hidden;
