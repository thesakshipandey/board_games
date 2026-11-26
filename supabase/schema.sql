-- =====================================================================================
-- The Game Shelf: Supabase schema
-- Run once in the SQL editor (or with tools/supabase_setup.py). Safe to re-run.
--
-- Public (anyone):      games, bgg, offers, extras, fakes, stores  -> read only
-- Owner (is_admin):     can also add / edit / delete games and their extras
-- Each signed-in user:  their own profile and their own user_games rows, nothing else
-- Server jobs (Apps Script, service_role key): bypass RLS to refresh prices and BGG data
-- =====================================================================================

create extension if not exists pg_net;   -- functions live in the "net" schema

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Server-side settings (never exposed through the API).
--   admin_emails   comma separated, these accounts become owners on sign-up
--   welcome_url    Apps Script web app URL that sends the welcome email
--   welcome_secret shared secret the Apps Script checks
create table if not exists private.settings (
  key text primary key,
  value text not null
);

-- ------------------------------------------------------------------ profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null,
  display_name text check (display_name is null or char_length(display_name) between 2 and 40),
  username text check (username is null or username ~ '^[a-z0-9_]{3,20}$'),
  avatar_url text,
  favourite_count int check (favourite_count is null or favourite_count between 1 and 20),
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen timestamptz,
  welcomed_at timestamptz
);
create unique index if not exists profiles_username_key on public.profiles (username);

-- ------------------------------------------------------------------ catalogue
create table if not exists public.games (
  id bigint generated always as identity primary key,
  name text not null,
  category text not null check (category in ('Boards', 'Cards', 'Duels')),
  also_in text[] not null default '{}',
  min_players int, max_players int, min_time int, max_time int, age int,
  weight numeric(4, 2),
  genre text,
  tags text[] not null default '{}',
  list_price int,
  buy_link text,
  bgg_id bigint,
  sheet_row int,                         -- position in the Google Sheet tab (for the nightly mirror)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists games_name_key on public.games (lower(name));
create index if not exists games_bgg_idx on public.games (bgg_id);

-- BoardGameGeek data, cached server-side (BGG asks for server-side requests + caching).
create table if not exists public.bgg (
  bgg_id bigint primary key,
  name text,
  year int,
  image text,
  thumb text,
  rating numeric(4, 2),
  rank int,
  weight numeric(4, 2),
  best_players text,
  mechanics text[] not null default '{}',
  categories text[] not null default '{}',
  designers text[] not null default '{}',
  description text,
  source text not null default 'bgg',   -- 'bgg' (XML API) or 'bgfinder' / 'ranks' (partial)
  updated_at timestamptz not null default now()
);

-- Indian store listings from BGFinder (every listing, so the Add page can search them too).
create table if not exists public.offers (
  id bigint generated always as identity primary key,
  bgg_id bigint not null,
  bgf_name text,
  store text,
  listing text,
  price int,
  status text,
  url text,
  updated_at timestamptz not null default now()
);
create index if not exists offers_bgg_idx on public.offers (bgg_id);

create table if not exists public.extras (
  id bigint generated always as identity primary key,
  game_id bigint not null references public.games on delete cascade,
  type text not null check (type in ('Expansion', 'Edition', 'Accessory')),
  name text not null,
  bgg_link text,
  price int,
  store text,
  buy_link text,
  note text,
  sort int not null default 0
);
create index if not exists extras_game_idx on public.extras (game_id);

-- Counterfeit / budget sellers: 'scrape' rows are replaced nightly, 'list' rows are kept by hand.
create table if not exists public.fakes (
  id bigint generated always as identity primary key,
  game_id bigint not null references public.games on delete cascade,
  store text not null,
  listing text,
  price int,
  in_stock boolean,
  status text,
  url text,
  note text,
  source text not null default 'list' check (source in ('list', 'scrape')),
  updated_at timestamptz not null default now()
);
create index if not exists fakes_game_idx on public.fakes (game_id);

create table if not exists public.stores (
  id bigint generated always as identity primary key,
  name text not null unique,
  url text,
  search_url text,                        -- {q} = game name
  kind text not null default 'india' check (kind in ('india', 'counterfeit')),
  sort int not null default 0
);

-- ------------------------------------------------------------------ personal data
create table if not exists public.user_games (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  game_id bigint not null references public.games on delete cascade,
  status text check (status in ('Wishlist', 'On the way', 'Owned', 'DIY')),
  interest text check (interest in ('Really want', 'Normal', 'Maybe')),
  interest_since timestamptz,
  authenticity text check (authenticity in ('VERIFIED ORIGINAL', 'SUSPECTED COUNTERFEIT', 'UNKNOWN')),
  price_paid int check (price_paid >= 0),
  rating numeric(3, 1) check (rating between 0 and 10),
  plays int not null default 0 check (plays >= 0),
  notes text check (char_length(notes) <= 1000),
  edition text check (char_length(edition) <= 80),
  acquired_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
create index if not exists user_games_game_idx on public.user_games (game_id);

-- Data waiting for an account that has not signed up yet (matched on email at sign-up).
create table if not exists public.user_games_import (
  email text not null,
  game_name text not null,
  status text, interest text, interest_since timestamptz, authenticity text,
  price_paid int, rating numeric(3, 1), plays int, notes text, edition text,
  primary key (email, game_name)
);

-- ------------------------------------------------------------------ helpers
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create or replace function public.user_games_before() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if new.interest is distinct from (case when tg_op = 'UPDATE' then old.interest end) then
    new.interest_since = case when new.interest is null then null else now() end;
  end if;
  if new.interest is not null and new.status is null then new.status = 'Wishlist'; end if;
  return new;
end $$;

drop trigger if exists games_touch on public.games;
create trigger games_touch before update on public.games for each row execute function public.touch_updated_at();
drop trigger if exists user_games_touch on public.user_games;
create trigger user_games_touch before insert or update on public.user_games for each row execute function public.user_games_before();

create or replace function public.username_available(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select lower(name) ~ '^[a-z0-9_]{3,20}$'
     and not exists (select 1 from public.profiles where username = lower(name) and id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'));
$$;

-- ------------------------------------------------------------------ sign-up + welcome email
create or replace function private.maybe_welcome(uid uuid) returns void
language plpgsql security definer set search_path = public, private, extensions as $$
declare
  p public.profiles;
  confirmed timestamptz;
  provider text;
  url text := (select value from private.settings where key = 'welcome_url');
  secret text := (select value from private.settings where key = 'welcome_secret');
begin
  select * into p from public.profiles where id = uid;
  select email_confirmed_at, raw_app_meta_data->>'provider' into confirmed, provider from auth.users where id = uid;
  if p.id is null or p.username is null or confirmed is null or p.welcomed_at is not null then return; end if;
  update public.profiles set welcomed_at = now() where id = uid;
  if url is null then return; end if;
  perform net.http_post(
    url := url,
    body := jsonb_build_object('action', 'welcome', 'secret', secret, 'email', p.email, 'name', p.display_name,
      'username', p.username, 'joined', p.created_at, 'provider', coalesce(provider, 'email'), 'isAdmin', p.is_admin),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 20000
  );
end $$;

create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}');
  uname text := lower(nullif(meta->>'username', ''));
  dname text := left(coalesce(nullif(meta->>'display_name', ''), nullif(meta->>'full_name', ''), nullif(meta->>'name', ''), split_part(new.email, '@', 1)), 40);
  admins text := coalesce((select value from private.settings where key = 'admin_emails'), '');
begin
  if uname is not null and (uname !~ '^[a-z0-9_]{3,20}$' or exists (select 1 from public.profiles where username = uname)) then
    uname := null;   -- they pick one on first visit instead
  end if;
  if char_length(dname) < 2 then dname := dname || '_'; end if;
  insert into public.profiles (id, email, display_name, username, avatar_url, is_admin)
  values (new.id, new.email, dname, uname, coalesce(meta->>'avatar_url', meta->>'picture'),
          lower(new.email) = any (string_to_array(replace(lower(admins), ' ', ''), ',')))
  on conflict (id) do nothing;
  -- Claim anything imported for this email (e.g. the owner's shelf from the Google Sheet).
  insert into public.user_games (user_id, game_id, status, interest, interest_since, authenticity, price_paid, rating, plays, notes, edition)
  select new.id, g.id, i.status, i.interest, i.interest_since, i.authenticity, i.price_paid, i.rating, coalesce(i.plays, 0), i.notes, i.edition
  from public.user_games_import i join public.games g on lower(g.name) = lower(i.game_name)
  where lower(i.email) = lower(new.email)
  on conflict do nothing;
  update public.user_games ug set interest_since = i.interest_since
  from public.user_games_import i join public.games g on lower(g.name) = lower(i.game_name)
  where ug.user_id = new.id and ug.game_id = g.id and lower(i.email) = lower(new.email) and i.interest_since is not null;
  delete from public.user_games_import where lower(email) = lower(new.email);
  perform private.maybe_welcome(new.id);
  return new;
end $$;

create or replace function private.on_user_confirmed() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then perform private.maybe_welcome(new.id); end if;
  return new;
end $$;

create or replace function private.on_profile_named() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if old.username is null and new.username is not null then perform private.maybe_welcome(new.id); end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();
drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users for each row execute function private.on_user_confirmed();
drop trigger if exists on_profile_named on public.profiles;
create trigger on_profile_named after update of username on public.profiles for each row execute function private.on_profile_named();

-- ------------------------------------------------------------------ row level security
alter table public.profiles enable row level security;
alter table public.games enable row level security;
alter table public.bgg enable row level security;
alter table public.offers enable row level security;
alter table public.extras enable row level security;
alter table public.fakes enable row level security;
alter table public.stores enable row level security;
alter table public.user_games enable row level security;
alter table public.user_games_import enable row level security;   -- no policies: server only

grant usage on schema public to anon, authenticated, service_role;
-- Server jobs (service_role) manage everything; RLS does not apply to them.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant usage on all sequences in schema public to authenticated;
grant execute on all functions in schema public to service_role;
grant select on public.games, public.bgg, public.offers, public.extras, public.fakes, public.stores to anon, authenticated;
grant insert, update, delete on public.games, public.bgg, public.extras, public.fakes, public.stores to authenticated;
grant select, insert, update, delete on public.user_games to authenticated;
grant select on public.profiles to authenticated;
revoke update on public.profiles from authenticated;
grant update (display_name, username, avatar_url, favourite_count, last_seen) on public.profiles to authenticated;
revoke all on public.user_games_import from anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['games', 'bgg', 'offers', 'extras', 'fakes', 'stores'] loop
    execute format('drop policy if exists "%1$s: anyone can read" on public.%1$I', t);
    execute format('create policy "%1$s: anyone can read" on public.%1$I for select to anon, authenticated using (true)', t);
  end loop;
  foreach t in array array['games', 'bgg', 'extras', 'fakes', 'stores'] loop
    execute format('drop policy if exists "%1$s: owner can write" on public.%1$I', t);
    execute format('create policy "%1$s: owner can write" on public.%1$I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

drop policy if exists "profiles: read own (owner reads all)" on public.profiles;
create policy "profiles: read own (owner reads all)" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "user_games: own rows only" on public.user_games;
create policy "user_games: own rows only" on public.user_games for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------------------ the public catalogue in one call
create or replace function public.catalog() returns json
language sql stable set search_path = public as $$
  select json_build_object(
    'games', coalesce((select json_agg(x order by lower(x.name)) from (
      select g.id, g.name, g.category, g.also_in as "alsoIn",
             g.min_players as "minP", g.max_players as "maxP", g.min_time as "minT", g.max_time as "maxT", g.age,
             coalesce(g.weight, b.weight) as weight, g.genre, g.tags, g.list_price as price, g.buy_link as "buyLink",
             g.bgg_id as "bggId", case when g.bgg_id is not null then 'https://boardgamegeek.com/boardgame/' || g.bgg_id end as "bggLink",
             b.year, b.image, b.thumb, b.rating as "bggRating", b.rank as "bggRank", b.best_players as "bestPlayers",
             b.mechanics, b.categories as "bggCategories", b.designers,
             case when char_length(b.description) > 900 then regexp_replace(left(b.description, 900), '[\s,;:.]+\S*$', '') else b.description end as description,
             coalesce(char_length(b.description) > 900, false) as "descriptionCut",
             coalesce((select json_agg(json_build_object('listing', o.listing, 'store', o.store, 'price', o.price, 'status', o.status, 'url', o.url) order by o.price nulls last)
                       from public.offers o where o.bgg_id = g.bgg_id), '[]') as offers,
             coalesce((select json_agg(json_build_object('type', e.type, 'name', e.name, 'bgg', e.bgg_link, 'price', e.price, 'store', e.store, 'buy', e.buy_link, 'note', e.note) order by e.sort, e.id)
                       from public.extras e where e.game_id = g.id), '[]') as extras,
             coalesce((select json_agg(json_build_object('store', f.store, 'listing', f.listing, 'price', f.price, 'inStock', f.in_stock, 'status', f.status, 'url', f.url, 'note', f.note) order by f.price nulls last)
                       from public.fakes f where f.game_id = g.id), '[]') as fakes
      from public.games g left join public.bgg b on b.bgg_id = g.bgg_id) x), '[]'),
    'stores', coalesce((select json_agg(json_build_object('name', name, 'url', url, 'search', search_url) order by sort, name) from public.stores where kind = 'india'), '[]'),
    'counterfeit', coalesce((select json_agg(json_build_object('name', name, 'url', url, 'search', search_url) order by sort, name) from public.stores where kind = 'counterfeit'), '[]'),
    'pricesUpdated', (select max(updated_at) from public.offers),
    'bggUpdated', (select max(updated_at) from public.bgg),
    'built', now()
  );
$$;
grant execute on function public.catalog() to anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- Owner dashboard: members and how many games each tracks (owner only).
create or replace function public.admin_members() returns table (
  display_name text, username text, email text, joined timestamptz, last_seen timestamptz, owned bigint, wishlist bigint, provider text)
language sql stable security definer set search_path = public as $$
  select p.display_name, p.username, p.email, p.created_at, p.last_seen,
         count(*) filter (where ug.status in ('Owned', 'DIY')),
         count(*) filter (where ug.status = 'Wishlist'),
         (select u.raw_app_meta_data->>'provider' from auth.users u where u.id = p.id)
  from public.profiles p left join public.user_games ug on ug.user_id = p.id
  where public.is_admin()
  group by p.id order by p.created_at;
$$;
grant execute on function public.admin_members() to authenticated;
