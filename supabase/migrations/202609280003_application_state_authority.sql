-- The administrator-controlled state is the authoritative application switch.
-- Previously, a position could display "Applications open" while this function
-- rejected every application because an optional schedule was stale or entered
-- in a different timezone. The schedule remains available for display.

create or replace function public.submit_application(p_position_id uuid)
returns public.candidate_applications
language plpgsql
security definer
set search_path = public
as $$
declare
  position_row public.positions;
  application_row public.candidate_applications;
begin
  select * into position_row
  from public.positions
  where id = p_position_id
  for update;

  if not found or position_row.state <> 'application_open' then
    raise exception 'Applications are not open for this position';
  end if;

  insert into public.candidate_applications (
    user_id, position_id, status, rejection_reason, reviewed_by, reviewed_at, updated_at
  )
  values (auth.uid(), p_position_id, 'pending', null, null, null, now())
  on conflict (user_id, position_id) do update
    set status = 'pending',
        rejection_reason = null,
        reviewed_by = null,
        reviewed_at = null,
        updated_at = now()
  where public.candidate_applications.status = 'rejected'
  returning * into application_row;

  if application_row.id is null then
    raise exception 'An active application already exists';
  end if;

  return application_row;
end;
$$;

grant execute on function public.submit_application(uuid) to authenticated;
