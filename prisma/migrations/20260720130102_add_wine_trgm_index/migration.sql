-- Enables fuzzy name matching used for import-time dedup (matching a new
-- CSV row against existing generic wines) and, later, scan matching.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_wines_item_name_trgm ON wines USING gin (item_name gin_trgm_ops);
