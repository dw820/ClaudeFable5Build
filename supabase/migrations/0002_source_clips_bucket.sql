-- 0002_source_clips_bucket.sql
-- Private bucket for source video clips + per-project clips.json manifest.
-- Written by preprocess (upload). Downloaded by the agent worker (service-role
-- key) into a local cache before render. Private: source footage is never
-- world-readable; access is via the service role only.
insert into storage.buckets (id, name, public)
values ('source-clips', 'source-clips', false)
on conflict (id) do nothing;
