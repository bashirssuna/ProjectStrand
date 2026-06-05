/**
 * Bootstrap or promote the PLATFORM super-admin (the operator who manages all
 * organisations from the Admin Center). Run once after deploying.
 *
 * Render: open the web service → Shell, then:
 *   SUPER_ADMIN_EMAIL=admin@makepistat.org \
 *   SUPER_ADMIN_PASSWORD='choose-a-strong-password' \
 *   SUPER_ADMIN_NAME='Makerere Epidemiology and Statistical Center' \
 *   npm run create-admin
 *
 * If the email already exists it is promoted to super-admin and its password reset.
 */
import { q, one } from "../src/server/db";
import { id } from "../src/lib/ids";
import { hashPassword } from "../src/lib/password";

async function main() {
  const email = (process.env.SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD || "";
  const name = process.env.SUPER_ADMIN_NAME || "Platform Admin";

  if (!email || password.length < 8) {
    console.error("Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (min 8 chars).");
    process.exit(1);
  }

  const hash = hashPassword(password);
  const existing = await one<{ id: string }>(`SELECT id FROM app_user WHERE email=$1`, [email]);

  if (existing) {
    await q(`UPDATE app_user SET is_super_admin=true, status='active', password_hash=$2, name=$3 WHERE id=$1`,
      [existing.id, hash, name]);
    console.log(`Promoted existing user to platform super-admin: ${email}`);
  } else {
    const uid = id("usr");
    await q(`INSERT INTO app_user (id,email,name,password_hash,status,is_super_admin) VALUES ($1,$2,$3,$4,'active',true)`,
      [uid, email, name, hash]);
    await q(`INSERT INTO user_profile (id,user_id) VALUES ($1,$2)`, [id("up"), uid]);
    console.log(`Created platform super-admin: ${email}`);
  }
  console.log("Sign in at /login, then open the Admin Center to create organisations.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
