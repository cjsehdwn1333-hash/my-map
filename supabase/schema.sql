-- 공유 지도 DB 스키마
-- Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run 하세요. (여러 번 실행해도 안전합니다)
-- 캘린더 앱과 같은 Supabase 프로젝트를 써도 됩니다. (프로필 표는 서로 공유합니다)

-- 1) 프로필 (이름). 캘린더 앱과 같은 정의라서 둘 중 아무거나 먼저 실행해도 됩니다.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  notify boolean not null default true,
  seen_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "profiles read" on public.profiles;
drop policy if exists "profiles insert own" on public.profiles;
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated using (true);
create policy "profiles insert own" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name',''), split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
insert into public.profiles (id, name)
  select id, coalesce(nullif(raw_user_meta_data->>'name',''), split_part(email,'@',1)) from auth.users
  on conflict (id) do nothing;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- 2) 장소: 로그인한 모두가 읽고, 만든 사람만 수정·삭제
create table if not exists public.places (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  name text not null check (char_length(name) between 1 and 60),
  memo text not null default '' check (char_length(memo) <= 500),
  photos text[] not null default '{}' check (cardinality(photos) <= 6),  -- 사진 저장소 경로 목록
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 가볼 곳 / 가본 곳, 링크(인스타 게시물 등), 가본 날짜. 이미 설치한 경우에도 이 부분만 다시 실행하면 열이 추가됩니다.
alter table public.places add column if not exists status text not null default 'want';
alter table public.places add column if not exists links text[] not null default '{}';
alter table public.places add column if not exists visited_at timestamptz;
alter table public.places drop constraint if exists places_status_check;
alter table public.places add constraint places_status_check check (status in ('want','visited'));
alter table public.places drop constraint if exists places_links_check;
alter table public.places add constraint places_links_check check (cardinality(links) <= 10 and coalesce(length(array_to_string(links, ' ')), 0) <= 20000);

alter table public.places enable row level security;
drop policy if exists "places read" on public.places;
drop policy if exists "places insert own" on public.places;
drop policy if exists "places update own" on public.places;
drop policy if exists "places delete own" on public.places;
create policy "places read" on public.places for select to authenticated using (true);
create policy "places insert own" on public.places for insert to authenticated with check (owner = auth.uid());
create policy "places update own" on public.places for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "places delete own" on public.places for delete to authenticated using (owner = auth.uid());
drop trigger if exists places_touch on public.places;
create trigger places_touch before update on public.places for each row execute function public.touch_updated_at();

-- 3) 사진 저장소 (비공개 버킷. 로그인한 사람만 볼 수 있고, 올린 사람만 지울 수 있음)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('place-photos', 'place-photos', false, 5242880, array['image/jpeg'])
  on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg'];
drop policy if exists "photos read" on storage.objects;
drop policy if exists "photos insert own" on storage.objects;
drop policy if exists "photos delete own" on storage.objects;
create policy "photos read" on storage.objects for select to authenticated
  using (bucket_id = 'place-photos');
create policy "photos insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'place-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'place-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- 4) 실시간 반영
do $$ begin
  begin alter publication supabase_realtime add table public.places; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end;
end $$;
