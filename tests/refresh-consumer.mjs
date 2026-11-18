import dbModule from "../dist/packages/shared/db.js";
import tokenModule from "../dist/packages/shared/tokens.js";
import providerModule from "../dist/packages/shared/provider.js";
const { db } = dbModule;
const { withAccess } = tokenModule;
const { fetchEmployees, ProviderError } = providerModule;
let first = true;
withAccess(process.argv[2], 0, async (token) => {
  try {
    return await fetchEmployees(token, new URLSearchParams());
  } catch (error) {
    if (first && error instanceof ProviderError && error.status === 401) {
      first = false;
      process.send("rejected");
      await new Promise((resolve) => process.once("message", resolve));
    }
    throw error;
  }
})
  .then((page) => {
    if (page.items.length !== 2) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    process.disconnect();
  });
