// Renders the Rill Agent app and tray icons from the official Rill logo (public/assets/rill-logo-wh.svg).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "assets");
const logoSvg = readFileSync(join(here, "..", "..", "public", "assets", "rill-logo-wh.svg"), "utf8");
mkdirSync(assets, { recursive: true });

// Inner markup of the logo (defs + shapes) so it can be nested inside a branded tile.
const logoBody = logoSvg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
if (!logoBody.includes("rill-mask-perfect")) throw new Error("Unexpected Rill logo format");

const TILE = "#171b1c";
const TILE_BORDER = "#2c3436";

function iconSvg(size, statusColor) {
	const inset = statusColor ? 0.12 : 0.17;
	const logo = 1 - inset * 2;
	const status = statusColor
		? `<circle cx="0.8" cy="0.8" r="0.19" fill="${TILE}"/><circle cx="0.8" cy="0.8" r="0.14" fill="${statusColor}"/>`
		: "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1 1">
  <rect x="0.01" y="0.01" width="0.98" height="0.98" rx="0.22" fill="${TILE}" stroke="${TILE_BORDER}" stroke-width="0.02"/>
  <svg x="${inset}" y="${inset}" width="${logo}" height="${logo}" viewBox="0 0 400 400">${logoBody}</svg>
  ${status}
</svg>`;
}

function render(file, size, statusColor) {
	const png = new Resvg(iconSvg(size, statusColor), { fitTo: { mode: "width", value: size } }).render().asPng();
	writeFileSync(join(assets, file), png);
}

render("icon.png", 256, null);
render("tray-connected.png", 32, "#87d4a5");
render("tray-disconnected.png", 32, "#94a3b8");
render("tray-attention.png", 32, "#e6c178");
console.log("Icons written to", assets);
