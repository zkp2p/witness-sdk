import { concatenateUint8Arrays } from '@reclaimprotocol/tls'
import type { ArraySlice } from '../types'

export const REDACTION_CHAR = '*'
export const REDACTION_CHAR_CODE = REDACTION_CHAR.charCodeAt(0)

/**
 * Check if a redacted string is congruent with the original string.
 * @param redacted the redacted content, redacted content is replaced by '*'
 * @param original the original content
 */
export function isRedactionCongruent<T extends string | Uint8Array>(redacted: T, original: T): boolean {
	for(let i = 0;i < redacted.length;i++) {
		const areSame = redacted[i] === original[i]
			|| (typeof redacted[i] === 'string' && redacted[i] === REDACTION_CHAR)
			|| (typeof redacted[i] === 'number' && redacted[i] === REDACTION_CHAR_CODE)
		if(!areSame) {
			return false
		}
	}

	return true
}

/**
 * Is the string fully redacted?
 */
export function isFullyRedacted<T extends string | Uint8Array>(redacted: T): boolean {
	for(let i = 0;i < redacted.length;i++) {
		if(
			redacted[i] !== REDACTION_CHAR
			&& redacted[i] !== REDACTION_CHAR_CODE
		) {
			return false
		}
	}

	return true
}

/**
 * Given some plaintext blocks and a redaction function, return the blocks that
 * need to be revealed to the other party
 *
 * Use case: we get the response for a request in several blocks, and want to redact
 * pieces that go through multiple blocks. We can use this function to get the
 * blocks that need to be revealed to the other party
 *
 * @example if we received ["secret is 12","345","678. Thanks"]. We'd want
 * to redact the "12345678" and reveal the rest. We'd pass in the blocks and
 * the redact function will return the redactions, namely [10,19].
 * The function will return the blocks ["secret is **","***. Thanks"].
 * The middle block is fully redacted, so it's not returned
 *
 * @param blocks blocks to reveal
 * @param redact function that returns the redactions
 * @returns blocks to reveal
 */
export function getBlocksToReveal<T extends { plaintext: Uint8Array }>(
	blocks: T[],
	redact: (total: Uint8Array) => ArraySlice[]
) {
	const slicesWithReveal: {
		block: T
		redactedPlaintext: Uint8Array
	}[] = blocks.map(block => ({
		block,
		// copy the plaintext to avoid mutating the original
		redactedPlaintext: new Uint8Array(block.plaintext)
	}))
	const total = concatenateUint8Arrays(
		blocks.map(b => b.plaintext)
	)
	const redactions = redact(total)
	if(!redactions.length) {
		return 'all'
	}

	let blockIdx = 0
	let cursorInBlock = 0
	let cursor = 0

	for(const redaction of redactions) {
		redactBlocks(redaction)
	}

	// only reveal blocks that have some data to reveal,
	// or are completely plaintext
	return slicesWithReveal
		.filter(s => !isFullyRedacted(s.redactedPlaintext))

	function redactBlocks(slice: ArraySlice) {
		while(cursor < slice.fromIndex) {
			advance()
		}

		while(cursor < slice.toIndex) {
			slicesWithReveal[blockIdx]
				.redactedPlaintext[cursorInBlock] = REDACTION_CHAR_CODE
			advance()
		}
	}

	function advance() {
		cursor += 1
		cursorInBlock += 1
		if(cursorInBlock >= blocks[blockIdx].plaintext.length) {
			blockIdx += 1
			cursorInBlock = 0
		}
	}
}