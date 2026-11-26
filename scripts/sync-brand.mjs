// Copies the AppruvIt logo from the repo's brand folder into the node, so the
// logo is changed in one place. Runs before every build (npm "prebuild").
// With --check (before every test run) it only verifies the node's icons match
// the brand folder, and fails if someone changed the logo without rebuilding.
//
//   ../assets/brand/logo.svg       required (or logo.png): used on light backgrounds
//   ../assets/brand/logo-dark.svg  optional (or logo-dark.png): used on dark backgrounds
//
// A PNG is wrapped in an SVG, so the node always points at .svg files.
// Outside the repo (no brand folder), the icons already in the node are kept.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const brand = join(here, '..', '..', 'assets', 'brand');
const nodeDir = join(here, '..', 'nodes', 'AppruvIt');
const MAX_BYTES = 200 * 1024;

/** The SVG text for a brand file (logo or logo-dark), or null if neither format exists. */
export function brandSvg(name, folder = brand) {
	const svg = join(folder, `${name}.svg`);
	if (existsSync(svg)) return readFileSync(svg, 'utf8');
	const png = join(folder, `${name}.png`);
	if (!existsSync(png)) return null;
	const data = readFileSync(png).toString('base64');
	return (
		'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64" width="64" height="64">' +
		`<image width="64" height="64" href="data:image/png;base64,${data}" xlink:href="data:image/png;base64,${data}"/></svg>\n`
	);
}

function main(check) {
	if (!existsSync(brand)) {
		console.log(`sync-brand: no ${brand}; keeping the icons already in the node.`);
		return;
	}
	const light = brandSvg('logo');
	if (!light) throw new Error(`sync-brand: add ${join(brand, 'logo.svg')} (or logo.png).`);
	const dark = brandSvg('logo-dark') ?? light;
	const icons = [
		['appruvit.svg', light],
		['appruvit.dark.svg', dark],
	];
	if (check) {
		const stale = icons.filter(([file, svg]) => {
			const target = join(nodeDir, file);
			return !existsSync(target) || readFileSync(target, 'utf8') !== svg;
		});
		if (stale.length) {
			console.error(`sync-brand: ${stale.map(([f]) => f).join(', ')} differ from assets/brand. Run npm run build.`);
			process.exit(1);
		}
		console.log('sync-brand: node icons match assets/brand.');
		return;
	}
	for (const [file, svg] of icons) {
		if (!svg.includes('<svg')) throw new Error(`sync-brand: ${file} source is not an SVG.`);
		const target = join(nodeDir, file);
		writeFileSync(target, svg);
		const size = statSync(target).size;
		if (size > MAX_BYTES) {
			console.warn(`sync-brand: ${file} is ${Math.round(size / 1024)} KB; n8n shows it at 40 px, so a smaller file (under 200 KB) loads faster.`);
		}
	}
	console.log('sync-brand: node icons updated from assets/brand.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.includes('--check'));
