-- Repoint lookup-table FK hinges from legacy public."Passenger" to operational public.passengers.
-- Adds auth binding on passengers and auto-links existing rows when auth.users is created.
-- Resolves case-sensitivity mismatch breaking email_logs / seat_requests / waitlist_submissions lookups.

begin;

-- ---------------------------------------------------------------------------
-- 1. Auth binding column on the operational passengers hub
-- ---------------------------------------------------------------------------
alter table public.passengers
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create unique index if not exists passengers_user_id_uidx
  on public.passengers (user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Repoint FK constraints to lowercase passengers
-- ---------------------------------------------------------------------------
alter table public.email_logs
  drop constraint if exists email_logs_passenger_id_fkey;

alter table public.seat_requests
  drop constraint if exists seat_requests_passenger_id_fkey;

alter table public.waitlist_submissions
  drop constraint if exists waitlist_submissions_passenger_id_fkey;

alter table public.email_logs
  add constraint email_logs_passenger_id_fkey
  foreign key (passenger_id) references public.passengers(id) on delete set null;

alter table public.seat_requests
  add constraint seat_requests_passenger_id_fkey
  foreign key (passenger_id) references public.passengers(id) on delete set null;

alter table public.waitlist_submissions
  add constraint waitlist_submissions_passenger_id_fkey
  foreign key (passenger_id) references public.passengers(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 3. Bind existing operational rows when a matching auth.users row is created
-- ---------------------------------------------------------------------------
create or replace function public.link_passenger_auth_by_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_passenger_id uuid;
begin
  select id into v_passenger_id
  from public.passengers
  where lower(email) = lower(new.email)
  limit 1;

  if v_passenger_id is null then
    return new;
  end if;

  update public.passengers
  set user_id = new.id, updated_at = now()
  where id = v_passenger_id
    and user_id is distinct from new.id;

  update public.resumes
  set user_id = new.id, updated_at = now()
  where passenger_id = v_passenger_id
    and (user_id is null or user_id is distinct from new.id);

  update public.waitlist_submissions
  set passenger_id = v_passenger_id, updated_at = now()
  where lower(email) = lower(new.email)
    and passenger_id is distinct from v_passenger_id;

  return new;
end;
$$;

drop trigger if exists trg_link_passenger_auth_by_email on auth.users;
create trigger trg_link_passenger_auth_by_email
  after insert on auth.users
  for each row
  execute function public.link_passenger_auth_by_email();

commit;