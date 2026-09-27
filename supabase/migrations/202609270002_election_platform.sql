-- Election data, integrity constraints, RLS, and database-enforced actions.
-- This migration deliberately exposes writes only through the RPC functions below.

alter table public.profiles
  add column if not exists full_name text,
  add column if not exists department text,
  add column if not exists student_id text unique,
  add column if not exists batch text,
  add column if not exists contact_number text,
  add column if not exists personal_photo_path text;

create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null default '',
  terms_and_conditions text not null default '',
  eligibility_requirements text not null default '',
  application_start timestamptz,
  application_end timestamptz,
  voting_start timestamptz,
  voting_end timestamptz,
  max_candidates integer check (max_candidates is null or max_candidates > 0),
  allow_self_vote boolean not null default false,
  state text not null default 'draft' check (state in ('draft','application_open','application_closed','voting_open','voting_closed','results_published')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (application_end is null or application_start is null or application_end > application_start),
  check (voting_end is null or voting_start is null or voting_end > voting_start)
);

create table if not exists public.candidate_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  position_id uuid not null references public.positions(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  rejection_reason text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, position_id)
);
create index if not exists candidate_applications_position_idx on public.candidate_applications(position_id, status);

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  voter_id uuid not null references public.profiles(id),
  position_id uuid not null references public.positions(id),
  candidate_application_id uuid not null references public.candidate_applications(id),
  idempotency_key uuid not null unique,
  created_at timestamptz not null default now(),
  unique (voter_id, position_id)
);
create index if not exists votes_position_idx on public.votes(position_id);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id),
  action_type text not null,
  target_type text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false) $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and policyname = 'Administrators can read all profiles'
  ) then
    create policy "Administrators can read all profiles"
      on public.profiles for select to authenticated
      using (public.is_admin());
  end if;
end $$;

create or replace function public.write_audit(p_action text, p_type text, p_target uuid, p_metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public
as $$ begin insert into public.audit_logs(actor_id, action_type, target_type, target_id, metadata) values (auth.uid(), p_action, p_type, p_target, p_metadata); end $$;

alter table public.positions enable row level security;
alter table public.candidate_applications enable row level security;
alter table public.votes enable row level security;
alter table public.audit_logs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'positions' and policyname = 'Authenticated users can read visible positions') then
    create policy "Authenticated users can read visible positions" on public.positions for select to authenticated using (state <> 'draft' or public.is_admin());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'candidate_applications' and policyname = 'Students can see own applications') then
    create policy "Students can see own applications" on public.candidate_applications for select to authenticated using (user_id = auth.uid() or status = 'approved' or public.is_admin());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'Admins can read audit logs') then
    create policy "Admins can read audit logs" on public.audit_logs for select to authenticated using (public.is_admin());
  end if;
end $$;
-- Votes have no SELECT policy: neither students nor admins can browse raw ballots.

create or replace function public.create_position(p_name text, p_description text default '', p_application_start timestamptz default null, p_application_end timestamptz default null, p_voting_start timestamptz default null, p_voting_end timestamptz default null, p_max_candidates integer default null, p_allow_self_vote boolean default false)
returns public.positions language plpgsql security definer set search_path = public as $$
declare created public.positions;
begin
  if not public.is_admin() then raise exception 'Administrator access required'; end if;
  insert into public.positions(name, description, application_start, application_end, voting_start, voting_end, max_candidates, allow_self_vote, created_by)
  values (trim(p_name), coalesce(p_description,''), p_application_start, p_application_end, p_voting_start, p_voting_end, p_max_candidates, p_allow_self_vote, auth.uid()) returning * into created;
  perform public.write_audit('position_created','position',created.id,jsonb_build_object('name',created.name));
  return created;
end $$;

create or replace function public.transition_position(p_position_id uuid, p_next_state text)
returns public.positions language plpgsql security definer set search_path = public as $$
declare current_position public.positions; updated_position public.positions;
begin
  if not public.is_admin() then raise exception 'Administrator access required'; end if;
  select * into current_position from public.positions where id = p_position_id for update;
  if not found then raise exception 'Position not found'; end if;
  if (current_position.state,p_next_state) not in (('draft','application_open'),('application_open','application_closed'),('application_closed','voting_open'),('voting_open','voting_closed'),('voting_closed','results_published')) then raise exception 'Invalid state transition'; end if;
  update public.positions set state = p_next_state, updated_at = now() where id = p_position_id returning * into updated_position;
  perform public.write_audit('position_state_changed','position',p_position_id,jsonb_build_object('from',current_position.state,'to',p_next_state));
  return updated_position;
end $$;

create or replace function public.submit_application(p_position_id uuid)
returns public.candidate_applications language plpgsql security definer set search_path = public as $$
declare position_row public.positions; application_row public.candidate_applications;
begin
  select * into position_row from public.positions where id = p_position_id for update;
  if not found or position_row.state <> 'application_open' or (position_row.application_start is not null and now() < position_row.application_start) or (position_row.application_end is not null and now() > position_row.application_end) then raise exception 'Applications are not open for this position'; end if;
  insert into public.candidate_applications(user_id, position_id, status, rejection_reason, reviewed_by, reviewed_at, updated_at)
  values (auth.uid(), p_position_id, 'pending', null, null, null, now())
  on conflict (user_id, position_id) do update set status = 'pending', rejection_reason = null, reviewed_by = null, reviewed_at = null, updated_at = now()
  where public.candidate_applications.status = 'rejected'
  returning * into application_row;
  if application_row.id is null then raise exception 'An active application already exists'; end if;
  return application_row;
end $$;

create or replace function public.review_application(p_application_id uuid, p_approve boolean, p_rejection_reason text default null)
returns public.candidate_applications language plpgsql security definer set search_path = public as $$
declare application_row public.candidate_applications; position_row public.positions; reviewed public.candidate_applications;
begin
  if not public.is_admin() then raise exception 'Administrator access required'; end if;
  select * into application_row from public.candidate_applications where id = p_application_id for update;
  select * into position_row from public.positions where id = application_row.position_id for update;
  if not found or position_row.state not in ('application_open','application_closed') then raise exception 'This application cannot be reviewed now'; end if;
  if p_approve and position_row.max_candidates is not null and (select count(*) from public.candidate_applications where position_id = position_row.id and status = 'approved') >= position_row.max_candidates then raise exception 'Candidate limit reached'; end if;
  update public.candidate_applications set status = case when p_approve then 'approved' else 'rejected' end, rejection_reason = case when p_approve then null else nullif(trim(p_rejection_reason),'') end, reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now() where id = p_application_id returning * into reviewed;
  perform public.write_audit(case when p_approve then 'application_approved' else 'application_rejected' end,'candidate_application',p_application_id,'{}');
  return reviewed;
end $$;

create or replace function public.set_member_status(p_member_id uuid, p_status text)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare updated_profile public.profiles;
begin
  if not public.is_admin() then raise exception 'Administrator access required'; end if;
  if p_member_id = auth.uid() then raise exception 'You cannot remove your own administrator access'; end if;
  if p_status not in ('active','suspended') then raise exception 'Invalid account status'; end if;
  update public.profiles set account_status = p_status, updated_at = now() where id = p_member_id returning * into updated_profile;
  if not found then raise exception 'Member not found'; end if;
  perform public.write_audit(case when p_status = 'suspended' then 'member_suspended' else 'member_reactivated' end,'profile',p_member_id,jsonb_build_object('email',updated_profile.email));
  return updated_profile;
end $$;

create or replace function public.admin_people()
returns table(id uuid, full_name text, email text, department text, student_id text, batch text, role text, account_status text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.email, p.department, p.student_id, p.batch, p.role, p.account_status, p.created_at
  from public.profiles p
  where public.is_admin()
  order by p.created_at desc
$$;

create or replace function public.cast_vote(p_position_id uuid, p_candidate_application_id uuid, p_idempotency_key uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare position_row public.positions; candidate_row public.candidate_applications; existing_vote public.votes; vote_id uuid;
begin
  select * into existing_vote from public.votes where idempotency_key = p_idempotency_key;
  if found then
    if existing_vote.voter_id = auth.uid() then return existing_vote.id; else raise exception 'Invalid vote request'; end if;
  end if;
  select * into position_row from public.positions where id = p_position_id for update;
  if not found or position_row.state <> 'voting_open' or (position_row.voting_start is not null and now() < position_row.voting_start) or (position_row.voting_end is not null and now() > position_row.voting_end) then raise exception 'Voting is not open for this position'; end if;
  select * into candidate_row from public.candidate_applications where id = p_candidate_application_id and position_id = p_position_id and status = 'approved';
  if not found then raise exception 'Candidate is not eligible for this position'; end if;
  if not position_row.allow_self_vote and candidate_row.user_id = auth.uid() then raise exception 'Self-voting is not allowed for this position'; end if;
  insert into public.votes(voter_id,position_id,candidate_application_id,idempotency_key) values(auth.uid(),p_position_id,p_candidate_application_id,p_idempotency_key) returning id into vote_id;
  return vote_id;
exception when unique_violation then
  select id into existing_vote from public.votes where voter_id = auth.uid() and position_id = p_position_id;
  if existing_vote.id is not null then raise exception 'You have already voted for this position'; end if;
  raise;
end $$;

create or replace function public.my_voting_status()
returns table(position_id uuid, voted boolean) language sql stable security definer set search_path = public
as $$ select p.id, exists(select 1 from public.votes v where v.position_id = p.id and v.voter_id = auth.uid()) from public.positions p where p.state <> 'draft' or public.is_admin() $$;

create or replace function public.candidate_pool(p_position_id uuid)
returns table(application_id uuid, full_name text, department text, student_id text, batch text) language sql stable security definer set search_path = public
as $$ select a.id, coalesce(pr.full_name, split_part(pr.email,'@',1)), pr.department, pr.student_id, pr.batch from public.candidate_applications a join public.profiles pr on pr.id = a.user_id where a.position_id = p_position_id and a.status = 'approved' $$;

create or replace function public.election_results(p_position_id uuid)
returns table(application_id uuid, full_name text, vote_count bigint, total_votes bigint) language plpgsql stable security definer set search_path = public as $$
declare position_row public.positions;
begin
  select * into position_row from public.positions where id = p_position_id;
  if not found or (position_row.state <> 'results_published' and not public.is_admin()) then raise exception 'Results are not available'; end if;
  return query select a.id, coalesce(pr.full_name,split_part(pr.email,'@',1)), count(v.id), (select count(*) from public.votes where position_id = p_position_id) from public.candidate_applications a join public.profiles pr on pr.id = a.user_id left join public.votes v on v.candidate_application_id = a.id where a.position_id = p_position_id and a.status = 'approved' group by a.id, pr.full_name, pr.email order by count(v.id) desc, a.id;
end $$;

revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.positions, public.candidate_applications, public.audit_logs to authenticated;
grant execute on function public.is_admin(), public.activate_verified_member(), public.create_position(text,text,timestamptz,timestamptz,timestamptz,timestamptz,integer,boolean), public.transition_position(uuid,text), public.submit_application(uuid), public.review_application(uuid,boolean,text), public.set_member_status(uuid,text), public.admin_people(), public.cast_vote(uuid,uuid,uuid), public.my_voting_status(), public.candidate_pool(uuid), public.election_results(uuid) to authenticated;
