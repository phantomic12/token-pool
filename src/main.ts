import { TokenPoolServer } from "@/server";

async function main() {
  const server = new TokenPoolServer();
  await server.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
