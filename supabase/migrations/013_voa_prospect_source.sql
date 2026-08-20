alter table prospects alter column epc_lmk_key drop not null;
alter table prospects add column if not exists voa_ba_reference text unique;
alter table prospects add column if not exists source text not null default 'epc';
