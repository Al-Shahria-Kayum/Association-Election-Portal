-- The election portal only admits users who authenticate with a DIU address.
-- Run this in the Supabase SQL Editor or via the Supabase CLI migration workflow.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique check (email = lower(email) and email like '%@diu.edu.bd'),
  role text not null default 'student' check (role in ('admin', 'student')),
  account_status text not null default 'active' check (account_status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and policyname = 'Members can read their own profile'
  ) then
    create policy "Members can read their own profile"
      on public.profiles for select to authenticated
      using (id = auth.uid());
  end if;
end $$;

-- No insert/update policy is exposed to browsers. A signed-in user can call this
-- function after completing the magic-link or email-OTP flow. auth.jwt() supplies
-- the authenticated email; the domain check is repeated inside the database.
create or replace function public.activate_verified_member()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  member_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  member_profile public.profiles;
begin
  if auth.uid() is null or member_email !~ '^[^@]+@diu[.]edu[.]bd$' then
    raise exception 'Only verified DIU email addresses may activate an account';
  end if;

  if exists (select 1 from public.profiles where id = auth.uid() and account_status = 'suspended') then
    raise exception 'This account has been removed from the election portal';
  end if;

  insert into public.profiles (id, email)
  values (auth.uid(), member_email)
  on conflict (id) do update set email = excluded.email, updated_at = now()
  returning * into member_profile;

  return member_profile;
end;
$$;

revoke all on function public.activate_verified_member() from public;
grant execute on function public.activate_verified_member() to authenticated;
