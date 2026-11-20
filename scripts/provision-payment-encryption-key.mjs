/** Never prints or replaces an existing payment master key. Back up the protected server env. */
import "../apps/api/dist/src/env.js";
import { randomBytes } from "node:crypto";
import {
  resolveEnvFilePath,
  readEnvValues,
  writeEnvFile,
} from "../apps/api/dist/src/admin/env-file.js";
const path = resolveEnvFilePath(),
  values = await readEnvValues(path);
const existing =
  process.env.PAYMENT_ENCRYPTION_KEY?.trim() ||
  values.get("PAYMENT_ENCRYPTION_KEY")?.trim() ||
  undefined;
if (existing !== undefined) {
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(existing) ||
    Buffer.from(existing, "base64").length !== 32
  )
    throw Error("Existing payment key is invalid; refusing to replace it");
  console.log("Payment encryption key preserved; value is not displayed");
} else {
  await writeEnvFile(path, {
    PAYMENT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  });
  console.log(
    "Payment encryption key provisioned in server env; back up securely and restart API",
  );
}
