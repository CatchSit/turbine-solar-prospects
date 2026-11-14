-- Videos on lead and quote documents (Greg, 2026-11-14): allow .mov and
-- .mp4 in the private `proposals` bucket. crm.html caps videos at 45 MB and
-- everything else at 20 MB; the bucket limit is raised to 45 MB so videos
-- fit (Supabase's own per-file upload cap on this plan is 50 MB). The type
-- list is 018's plus the two video types, so PDFs from the Proposal
-- Generator keep working. Safe to run twice.
update storage.buckets
set file_size_limit = 47185920, -- 45 MB
    allowed_mime_types = array[
      'application/pdf',
      'image/jpeg', 'image/png', 'image/heic',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'video/quicktime', 'video/mp4'
    ]
where id = 'proposals';
