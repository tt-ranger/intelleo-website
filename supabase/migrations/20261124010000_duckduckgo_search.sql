alter table editorial.search_calls
  drop constraint if exists search_calls_provider_check;

-- Existing Brave counts can remain in the ledger.
alter table editorial.search_calls
  add constraint search_calls_provider_check
  check (provider in ('brave', 'duckduckgo', 'you'));
