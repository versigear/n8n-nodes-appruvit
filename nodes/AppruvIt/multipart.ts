import { randomBytes } from 'crypto';

import type { IDataObject } from 'n8n-workflow';

export type FilePart = { name: string; mimeType: string; data: Buffer };

/**
 * multipart/form-data for POST /v1/requests: a `request` part with the JSON
 * body, then one `file` part per attachment. Built here as one Buffer so the
 * upload doesn't depend on how n8n's HTTP helper treats FormData bodies.
 */
export function buildMultipart(request: IDataObject, files: FilePart[]): { body: Buffer; contentType: string } {
	const boundary = `----appruvit${randomBytes(12).toString('hex')}`;
	const parts: Buffer[] = [];
	const quote = (value: string) => value.replace(/["\r\n\\]/g, '_');

	parts.push(
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\n` +
				`Content-Type: application/json\r\n\r\n${JSON.stringify(request)}\r\n`,
		),
	);
	for (const file of files) {
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quote(file.name)}"\r\n` +
					`Content-Type: ${file.mimeType || 'application/octet-stream'}\r\n\r\n`,
			),
			file.data,
			Buffer.from('\r\n'),
		);
	}
	parts.push(Buffer.from(`--${boundary}--\r\n`));
	return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
