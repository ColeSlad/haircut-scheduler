CREATE TABLE media_assets (url TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('photo', 'video', 'poster')), validated_at BIGINT NOT NULL);
CREATE TABLE data_imports (name TEXT PRIMARY KEY, completed_at BIGINT NOT NULL);
