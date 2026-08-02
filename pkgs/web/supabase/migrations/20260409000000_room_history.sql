create table public.rooms (
  id bigint generated always as identity primary key,
  room_id text not null unique,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create index idx_rooms_owner_user_id on public.rooms(owner_user_id, created_at desc);

alter table public.rooms enable row level security;

create policy "Users can view own rooms"
  on public.rooms for select
  using ((select auth.uid()) = owner_user_id);

create policy "Users can create rooms"
  on public.rooms for insert
  with check ((select auth.uid()) = owner_user_id);

create policy "Users can update own rooms"
  on public.rooms for update
  using ((select auth.uid()) = owner_user_id)
  with check ((select auth.uid()) = owner_user_id);
