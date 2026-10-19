import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DOWNLOAD_TTL_MS,
	MAX_UPLOAD_BYTES,
	Transfers,
	UPLOAD_TTL_MS,
	type TransferOwner
} from './transfers';

const owner: TransferOwner = { userId: 'user-1', clientId: 'client-1' };
const file = { filename: 'report.pdf', contentType: 'application/pdf' };

describe('Transfers', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('serves a download repeatedly until it expires', () => {
		const transfers = new Transfers();
		const { token } = transfers.createDownload({ ...owner, ref: 'ref', partId: '2' });
		expect(transfers.resolveDownload(token)).toMatchObject({ ref: 'ref', partId: '2' });
		expect(transfers.resolveDownload(token)).not.toBeNull();
		vi.advanceTimersByTime(DOWNLOAD_TTL_MS);
		expect(transfers.resolveDownload(token)).toBeNull();
	});

	it('returns uploaded files in order to their owner', () => {
		const transfers = new Transfers();
		const a = transfers.createUpload(owner, file).uploadId;
		const b = transfers.createUpload(owner, {
			filename: 'b.txt',
			contentType: 'text/plain'
		}).uploadId;
		transfers.storeUpload(a, Buffer.from('first'));
		transfers.storeUpload(b, Buffer.from('second'));
		transfers.storeUpload(a, Buffer.from('replaced'));
		const files = transfers.takeUploads(owner, [b, a]);
		expect(files.map((f) => [f.filename, f.content.toString()])).toEqual([
			['b.txt', 'second'],
			['report.pdf', 'replaced']
		]);
	});

	it('refuses uploads of another user or client', () => {
		const transfers = new Transfers();
		const { uploadId } = transfers.createUpload(owner, file);
		transfers.storeUpload(uploadId, Buffer.from('x'));
		expect(() => transfers.takeUploads({ ...owner, clientId: 'other' }, [uploadId])).toThrow(
			/Unknown or expired/
		);
		expect(() => transfers.takeUploads({ ...owner, userId: 'other' }, [uploadId])).toThrow(
			/Unknown or expired/
		);
	});

	it('refuses an upload without content, after expiry, or once released', () => {
		const transfers = new Transfers();
		const empty = transfers.createUpload(owner, file).uploadId;
		expect(() => transfers.takeUploads(owner, [empty])).toThrow(/Nothing was uploaded/);

		const used = transfers.createUpload(owner, file).uploadId;
		transfers.storeUpload(used, Buffer.from('x'));
		transfers.releaseUploads([used]);
		expect(() => transfers.takeUploads(owner, [used])).toThrow(/Unknown or expired/);

		const late = transfers.createUpload(owner, file).uploadId;
		vi.advanceTimersByTime(UPLOAD_TTL_MS);
		expect(() => transfers.storeUpload(late, Buffer.from('x'))).toThrow(/Unknown or expired/);
	});

	it('limits the size of one file and of all pending uploads', () => {
		const transfers = new Transfers();
		const big = transfers.createUpload(owner, file).uploadId;
		expect(() => transfers.storeUpload(big, Buffer.alloc(MAX_UPLOAD_BYTES + 1))).toThrow(/25 MB/);
		for (let i = 0; i < 8; i++) {
			const id = transfers.createUpload(owner, file).uploadId;
			transfers.storeUpload(id, Buffer.alloc(MAX_UPLOAD_BYTES));
		}
		const over = transfers.createUpload(owner, file).uploadId;
		expect(() => transfers.storeUpload(over, Buffer.alloc(1))).toThrow(/Too many uploads/);
	});
});
