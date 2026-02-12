const { readFileSync, writeFileSync } = require("fs");
const { execSync } = require("child_process");

// Find all @1delta/abis package.json files (hoisted and nested)
const output = execSync(
  'find node_modules -path "*/@1delta/abis/package.json"',
  { encoding: "utf-8" }
);

const files = output.trim().split("\n").filter(Boolean);

for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, "utf-8"));
  if (pkg.type !== "module") {
    pkg.type = "module";
    writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`Patched ${file}: added "type": "module"`);
  }
}
