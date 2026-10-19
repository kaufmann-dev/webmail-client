import { randomBytes } from 'node:crypto';
import { MailError } from '../mail/errors';
import type { OutgoingAttachment } from '../mail/compose';

export const DOWNLOAD_TTL_MS = 15 * 60_000;
export const UPLOAD_TTL_MS = 60 * 60_000;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_PENDING_BYTES = 200 * 1024 * 1024;

/** The OAuth client of one user that a transfer belongs to. */
export interface TransferOwner {
	userId: string;
	clientId: string;
}

export interface Download extends TransferOwner {
	/** Mail-layer message ref, checked against the client's grants again when fetched. */
	ref: string;
	partId: string;
	expiresAt: number;
}

interface Upload extends TransferOwner {
	filename: string;
	contentType: string;
	content: Buffer | null;
	expiresAt: number;
}

const newToken = () => randomBytes(32).toString('base64url');

/**
 * Short-lived attachment links for MCP clients, so file bytes travel over HTTPS instead of through
 * tool calls. Kept in memory only: the app is one process, and mail never enters the database.
 * The token in the link is the only credential, so links are random, short-lived, and bound to the
 * user and OAuth client that created them.
 */
export class Transfers {
	private readonly downloads = new Map<string, Download>();
	private readonly uploads = new Map<string, Upload>();

	private sweep(): void {
		const now = Date.now();
		for (const [token, entry] of this.downloads) {
			if (entry.expiresAt <= now) this.downloads.delete(token);
		}
		for (const [id, entry] of this.uploads) {
			if (entry.expiresAt <= now) this.uploads.delete(id);
		}
	}

	createDownload(entry: Omit<Download, 'expiresAt'>): { token: string; expiresAt: number } {
		this.sweep();
		const token = newToken();
		const expiresAt = Date.now() + DOWNLOAD_TTL_MS;
		this.downloads.set(token, { ...entry, expiresAt });
		return { token, expiresAt };
	}

	/** A download until it expires; it may be fetched more than once, so clients can retry. */
	resolveDownload(token: string): Download | null {
		this.sweep();
		return this.downloads.get(token) ?? null;
	}

	createUpload(
		owner: TransferOwner,
		file: { filename: string; contentType: string }
	): { uploadId: string; expiresAt: number } {
		this.sweep();
		const uploadId = newToken();
		const expiresAt = Date.now() + UPLOAD_TTL_MS;
		this.uploads.set(uploadId, { ...owner, ...file, content: null, expiresAt });
		return { uploadId, expiresAt };
	}

	/** Stores the uploaded file; uploading again before it is used replaces it. */
	storeUpload(uploadId: string, content: Buffer): void {
		this.sweep();
		const upload = this.uploads.get(uploadId);
		if (!upload) throw new MailError('Unknown or expired upload.', 404);
		if (content.length > MAX_UPLOAD_BYTES) {
			throw new MailError('Files larger than 25 MB cannot be attached.', 413);
		}
		let pending = content.length;
		for (const other of this.uploads.values()) {
			if (other !== upload) pending += other.content?.length ?? 0;
		}
		if (pending > MAX_PENDING_BYTES) {
			throw new MailError('Too many uploads are waiting to be sent. Try again later.', 413);
		}
		upload.content = content;
	}

	/** The uploaded files, in order, if they all belong to this owner and have content. */
	takeUploads(owner: TransferOwner, uploadIds: string[]): OutgoingAttachment[] {
		this.sweep();
		return uploadIds.map((id) => {
			const upload = this.uploads.get(id);
			if (!upload || upload.userId !== owner.userId || upload.clientId !== owner.clientId) {
				throw new MailError(
					`Unknown or expired upload_id "${id}". Call create_attachment_upload again.`,
					404
				);
			}
			if (!upload.content) {
				throw new MailError(
					`Nothing was uploaded for ${upload.filename} yet. PUT the file to its upload_url first.`,
					409
				);
			}
			return {
				filename: upload.filename,
				contentType: upload.contentType,
				content: upload.content
			};
		});
	}

	/** Frees uploads once the message holding them was saved or sent. */
	releaseUploads(uploadIds: string[]): void {
		for (const id of uploadIds) this.uploads.delete(id);
	}
}

export const transfers = new Transfers();
