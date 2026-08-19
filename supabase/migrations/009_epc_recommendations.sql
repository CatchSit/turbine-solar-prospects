alter table prospects
  add column if not exists epc_recommends_solar boolean,
  add column if not exists epc_recommends_efficiency boolean;
