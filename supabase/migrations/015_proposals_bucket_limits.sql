-- 014 created the `proposals` bucket with file_size_limit/allowed_mime_types
-- left NULL, so Storage accepted any size/type from anyone calling the API
-- directly, bypassing index.html's client-side 20MB/PDF-only checks entirely.
-- 014 already applied live and its `on conflict do nothing` means re-running
-- it won't touch the existing bucket row, hence a new migration here.
update storage.buckets
set file_size_limit = 20971520, -- 20 MB, matches index.html's MAX_PROPOSAL_BYTES
    allowed_mime_types = array['application/pdf']
where id = 'proposals';
