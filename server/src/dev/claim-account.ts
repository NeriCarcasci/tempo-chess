import { client } from "../db/client.js";

/**
 * Dev-only: create a usable sign-in and hand it the data that already exists.
 *
 * The database was seeded before authentication existed, so every imported game
 * belongs to a placeholder profile (`local@tempo.chess`) with a random id. A
 * fresh signup mints a *different* profile id, which means the new account would
 * see nothing, and linking the same chess username would be refused because it
 * is already attached to the placeholder.
 *
 * This script closes that gap: it creates (or reuses) a Supabase user, marks the
 * email confirmed so a local run does not need a mailbox, then moves every row
 * that points at the placeholder profile over to the real one and deletes the
 * placeholder.
 *
 *   node --env-file=.env --import tsx src/dev/claim-account.ts <email> <password>
 *
 * Never run this against production: it writes directly to auth.users.
 */

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("usage: claim-account.ts <email> <password>");
  process.exit(1);
}
if (password.length < 8) {
  console.error("password must be at least 8 characters");
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
if (!url || !anon) {
  console.error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  process.exit(1);
}

const step = (n: number, msg: string) => console.log(`${n}. ${msg}`);

async function main(): Promise<void> {
  // 1. Create the auth user, tolerating one that already exists.
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await signup.json() as { id?: string; msg?: string; error_description?: string };
  if (signup.ok) step(1, `created auth user for ${email}`);
  else step(1, `signup returned "${body.msg ?? body.error_description}" (continuing, the user may already exist)`);

  // 2. Confirm the address. Locally there is no mailbox to click through.
  const confirmed = await client`
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now())
    where email = ${email!} returning id`;
  if (!confirmed[0]) {
    console.error(`   no auth user with email ${email}. Check the signup error above.`);
    process.exit(1);
  }
  const userId = String(confirmed[0].id);
  step(2, `email confirmed, auth uid ${userId}`);

  // 3. Verify the credentials actually work before touching any data.
  const signin = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signin.ok) {
    const err = await signin.json() as { msg?: string };
    console.error(`   sign-in still failing: ${err.msg}. Wrong password for an existing user?`);
    process.exit(1);
  }
  step(3, "sign-in verified");

  // 4. Make sure the profile row exists (the API does this on first call too).
  await client`
    insert into profiles (id, email) values (${userId}, ${email!})
    on conflict (id) do update set email = excluded.email`;
  step(4, "profile row ready");

  // 5. Adopt anything owned by a pre-auth placeholder profile. Every table that
  //    references profiles.id is discovered rather than listed, so a future
  //    table cannot be silently left behind.
  const orphans = await client`
    select id, email from profiles
    where id <> ${userId} and id not in (select id from auth.users)`;
  if (orphans.length === 0) {
    step(5, "no pre-auth profiles to adopt");
  } else {
    const refs = await client`
      select tc.table_name, kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY'
        and ccu.table_name = 'profiles' and ccu.column_name = 'id'
        and tc.table_schema = 'public'`;

    for (const orphan of orphans) {
      const oldId = String(orphan.id);
      let moved = 0;
      for (const ref of refs) {
        const table = String(ref.table_name);
        const column = String(ref.column_name);
        // Identifiers come from information_schema, not user input.
        const res = await client.unsafe(
          `update "${table}" set "${column}" = $1 where "${column}" = $2`,
          [userId, oldId],
        );
        const n = res.count ?? 0;
        if (n > 0) {
          console.log(`     ${table}.${column}: ${n}`);
          moved += n;
        }
      }
      await client`delete from profiles where id = ${oldId}`;
      step(5, `adopted ${moved} rows from ${orphan.email ?? oldId} and removed the placeholder`);
    }
  }

  const accounts = await client`
    select platform, username from linked_accounts where user_id = ${userId}`;
  console.log(`\nDone. Sign in at /login as ${email}`);
  console.log(
    accounts.length
      ? `Linked chess accounts: ${accounts.map((a) => `${a.username} (${a.platform})`).join(", ")}`
      : "No chess account linked yet; /account/connect will ask for one.",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
