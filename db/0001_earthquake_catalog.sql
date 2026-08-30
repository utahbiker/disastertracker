-- disaster-tracker/db/0001_earthquake_catalog.sql
--
-- OPTIONAL mirror of the bundled earthquake catalog into Supabase/Postgres.
-- The web app does not require this — it ships the catalog as static files.
-- Apply through your project's normal migration tooling when server-side
-- queries are actually needed.
--
-- Grant discipline per ADR-010: new tables need explicit grants (Data API
-- default changed 2026) AND RLS. Catalog data is public-read, service-write.

CREATE TABLE IF NOT EXISTS public.earthquake_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL,
  latitude     double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude    double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  depth_km     double precision,            -- NULL = unknown
  magnitude    double precision,            -- NULL = unknown (pre-1900 context rows)
  source       text NOT NULL CHECK (source IN ('comcat', 'iscgem', 'bridge', 'ngdc', 'topup')),
  event_name   text,                        -- only pre-1900 context rows carry names
  UNIQUE (occurred_at, latitude, longitude, source)
);

COMMENT ON TABLE public.earthquake_events IS
  'Merged earthquake catalog (ComCat 2000+, ISC-GEM 1900-1999, NGDC pre-1900 context). '
  'Provenance + completeness windows: disaster-tracker/METHODOLOGY.md. '
  'ngdc rows are damage-selected context, NEVER usable for rate estimation.';

CREATE INDEX IF NOT EXISTS earthquake_events_occurred_at_idx ON public.earthquake_events (occurred_at);
CREATE INDEX IF NOT EXISTS earthquake_events_magnitude_idx   ON public.earthquake_events (magnitude);
CREATE INDEX IF NOT EXISTS earthquake_events_latlon_idx      ON public.earthquake_events (latitude, longitude);

-- explicit grants (ADR-010): RLS controls rows, grants control table access at all
GRANT SELECT ON public.earthquake_events TO anon;
GRANT SELECT ON public.earthquake_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.earthquake_events TO service_role;

ALTER TABLE public.earthquake_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY earthquake_events_public_read
  ON public.earthquake_events FOR SELECT
  TO anon, authenticated
  USING (true);

-- no INSERT/UPDATE/DELETE policies: only service_role (which bypasses RLS) writes.
