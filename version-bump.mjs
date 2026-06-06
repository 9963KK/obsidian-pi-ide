import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const versions = fs.existsSync("versions.json") ? JSON.parse(fs.readFileSync("versions.json", "utf8")) : {};
versions[manifest.version] = manifest.minAppVersion;
fs.writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
