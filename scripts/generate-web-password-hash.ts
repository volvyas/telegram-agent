import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { PasswordVerifier } from "../src/web/PasswordVerifier.js";

const prompt = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
try {
  const password = await prompt.question("Password: ");
  const confirmation = await prompt.question("Confirm password: ");
  if (password !== confirmation) throw new Error("Passwords do not match");
  process.stdout.write(`${await PasswordVerifier.hash(password)}\n`);
} finally {
  prompt.close();
}
