export const APPLICATION_NAME = "codex-remote";

export function main(): void {
  console.log(`${APPLICATION_NAME} foundation is ready`);
}

if (import.meta.main) {
  main();
}
