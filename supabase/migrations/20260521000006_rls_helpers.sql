-- Helper functions used by RLS policies. SECURITY DEFINER lets them bypass RLS
-- when checking membership, otherwise the policy that uses them would recurse.

create or replace function public.is_project_member(p_project_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.project_members
    where project_id = p_project_id
      and user_id = p_user_id
      and invite_accepted_at is not null
  );
$$;

create or replace function public.project_role(p_project_id uuid, p_user_id uuid)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role
  from public.project_members
  where project_id = p_project_id
    and user_id = p_user_id
    and invite_accepted_at is not null
  limit 1;
$$;

-- Convenience: caller's role on a project (uses auth.uid()).
create or replace function public.my_project_role(p_project_id uuid)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select public.project_role(p_project_id, auth.uid());
$$;
